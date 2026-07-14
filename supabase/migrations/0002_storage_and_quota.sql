-- Camera Event Webapp - media storage bucket + race-safe quota accounting
--
-- Two concerns that have to be solved together:
--   1. Where the bytes live (a private bucket the browser cannot read).
--   2. How the counters that guard the bucket stay honest when a whole party
--      uploads at once.

-- ============================================================
-- Storage bucket
--
-- Private. Every read and write goes through a short-lived signed URL minted
-- by a route handler, so the bucket itself never needs a policy for
-- anon/authenticated - matching the default-deny posture of the tables.
--
-- file_size_limit and allowed_mime_types are enforced by the storage service
-- itself, so a client that skips our route handler and reuses a signed upload
-- URL still cannot push a 2 GB file or an executable through it. This is the
-- one check we cannot perform in our own code, because the bytes never pass
-- through our server on the way in.
-- ============================================================
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'event-media',
  'event-media',
  false,
  41943040, -- 40 MiB: a 15s 720p clip lands ~5 MB, with headroom for Android
            -- encoders that treat videoBitsPerSecond as a loose hint
  array['image/jpeg', 'video/webm', 'video/mp4']
)
on conflict (id) do update
  set public             = excluded.public,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- ============================================================
-- reserve_media_upload
--
-- Called by upload/init. Claims one of the guest's slots *before* a signed
-- upload URL exists, so a guest cannot open fifty parallel inits, upload
-- fifty files, and leave forty orphans sitting in the bucket after the
-- confirms start failing. Orphaned pending rows are swept after 1h by the
-- retention cron, so only recent ones count against the cap.
--
-- The lock on guest_sessions serialises inits per guest, which is what makes
-- the count-then-insert safe. Different guests never contend.
-- ============================================================
create function public.reserve_media_upload(
  p_event_id         uuid,
  p_guest_session_id uuid,
  p_storage_path     text,
  p_media_type       text,
  p_mime_type        text,
  p_size_bytes       bigint,
  p_duration_seconds numeric default null
) returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_max_uploads int;
  v_used        int;
  v_media_id    uuid;
begin
  -- Serialise this guest's inits against each other.
  perform 1 from public.guest_sessions
    where id = p_guest_session_id and event_id = p_event_id
    for update;
  if not found then
    raise exception 'guest_session_not_found' using errcode = 'P0002';
  end if;

  select max_uploads_per_guest into v_max_uploads
    from public.events
    where id = p_event_id and status = 'active' and deleted_at is null;
  if not found then
    raise exception 'event_not_available' using errcode = 'P0002';
  end if;

  -- Confirmed uploads plus reservations still in flight. A pending row older
  -- than an hour is an abandoned upload, not a live claim on a slot.
  select count(*) into v_used
    from public.media_items
    where guest_session_id = p_guest_session_id
      and (
        status = 'confirmed'
        or (status = 'pending' and created_at > now() - interval '1 hour')
      );

  if v_used >= v_max_uploads then
    raise exception 'upload_quota_exceeded' using errcode = 'P0001';
  end if;

  insert into public.media_items (
    event_id, guest_session_id, storage_path,
    media_type, mime_type, size_bytes, duration_seconds, status
  ) values (
    p_event_id, p_guest_session_id, p_storage_path,
    p_media_type, p_mime_type, p_size_bytes, p_duration_seconds, 'pending'
  )
  returning id into v_media_id;

  return v_media_id;
end;
$$;

comment on function public.reserve_media_upload is
  'upload/init: claims a per-guest slot and creates the pending row. Raises upload_quota_exceeded (P0001) when the guest is out of shots.';

-- ============================================================
-- confirm_media_upload
--
-- Called by upload/confirm once the bytes are in the bucket and EXIF has been
-- stripped. This is the authoritative gate: init's reservation is a courtesy
-- to avoid wasted uploads, but the counters only move here.
--
-- Both updates carry their cap in the WHERE clause, so the check and the
-- increment are one atomic statement rather than a read followed by a write
-- that a concurrent transaction can slip between. If either returns no rows,
-- the exception rolls back the whole function - a guest can never end up with
-- a spent slot but no photo, or a photo that nobody's quota paid for.
--
-- p_size_bytes is the size Storage actually reports, not what the client
-- claimed at init.
--
-- p_exif_stripped is passed in rather than hardcoded to true, because it is
-- only true for photos. Video metadata stripping needs ffmpeg and is a known
-- Phase 4 gap; recording "stripped" against a clip we never touched would
-- turn an audit flag into a false claim, which is worse than an honest false.
-- ============================================================
create function public.confirm_media_upload(
  p_media_id         uuid,
  p_event_id         uuid,
  p_guest_session_id uuid,
  p_size_bytes       bigint,
  p_exif_stripped    boolean
) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_status text;
begin
  -- Ownership is part of the lookup, not a separate check: a media_id that
  -- belongs to another guest reads as "not found", never as someone else's
  -- row we then decline to touch.
  select status into v_status
    from public.media_items
    where id = p_media_id
      and event_id = p_event_id
      and guest_session_id = p_guest_session_id
    for update;
  if not found then
    raise exception 'media_item_not_found' using errcode = 'P0002';
  end if;

  -- Replaying a confirm must not buy a second slot off one upload.
  if v_status <> 'pending' then
    raise exception 'media_item_not_pending' using errcode = 'P0001';
  end if;

  update public.guest_sessions gs
    set upload_count = gs.upload_count + 1,
        last_seen_at = now()
    where gs.id = p_guest_session_id
      and gs.upload_count < (
        select e.max_uploads_per_guest from public.events e where e.id = p_event_id
      );
  if not found then
    raise exception 'upload_quota_exceeded' using errcode = 'P0001';
  end if;

  update public.events e
    set storage_used_bytes = e.storage_used_bytes + p_size_bytes
    where e.id = p_event_id
      and e.storage_used_bytes + p_size_bytes <= e.max_storage_bytes;
  if not found then
    raise exception 'storage_quota_exceeded' using errcode = 'P0001';
  end if;

  update public.media_items
    set status        = 'confirmed',
        size_bytes    = p_size_bytes,
        exif_stripped = p_exif_stripped
    where id = p_media_id;
end;
$$;

comment on function public.confirm_media_upload is
  'upload/confirm: the authoritative quota gate. Increments both counters and flips the row to confirmed, atomically. Raises upload_quota_exceeded / storage_quota_exceeded (P0001).';

-- ============================================================
-- These run as security definer, so they would otherwise be callable by anon
-- through PostgREST - which would hand the browser exactly the counter writes
-- the rest of this schema is built to withhold. Only service_role, i.e. our
-- own route handlers, may call them.
-- ============================================================
revoke all on function public.reserve_media_upload(uuid, uuid, text, text, text, bigint, numeric) from public, anon, authenticated;
revoke all on function public.confirm_media_upload(uuid, uuid, uuid, bigint, boolean) from public, anon, authenticated;
grant execute on function public.reserve_media_upload(uuid, uuid, text, text, text, bigint, numeric) to service_role;
grant execute on function public.confirm_media_upload(uuid, uuid, uuid, bigint, boolean) to service_role;
