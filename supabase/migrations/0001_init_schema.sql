-- Camera Event Webapp - initial schema
-- events, guest_sessions, media_items + default-deny RLS

-- ============================================================
-- events
-- ============================================================
create table public.events (
  id                     uuid primary key default gen_random_uuid(),
  guest_token            text not null unique,
  host_token             text not null unique,
  name                   text not null check (length(trim(name)) between 1 and 120),
  created_at             timestamptz not null default now(),

  -- lifecycle: active -> archived (swept by retention) | deleted (removed by host)
  status                 text not null default 'active'
                           check (status in ('active', 'archived', 'deleted')),
  -- placeholder so per-event billing can land later without a breaking migration
  plan_tier              text not null default 'free',

  -- host-configured limits, mirrored by the zod schemas in lib/validation.ts
  max_guests             int not null default 50
                           check (max_guests between 1 and 500),
  max_uploads_per_guest  int not null default 20
                           check (max_uploads_per_guest between 1 and 100),
  max_storage_bytes      bigint not null default 5368709120
                           check (max_storage_bytes between 1 and 21474836480),
  storage_used_bytes     bigint not null default 0
                           check (storage_used_bytes >= 0),
  retention_days         int not null default 30
                           check (retention_days between 1 and 365),

  -- Delayed reveal. unlock_at is the scheduled moment; is_unlocked is the
  -- manual override and always wins; unlocked_at stamps when the reveal
  -- actually happened, which is what the retention clock counts from.
  unlock_at              timestamptz,
  is_unlocked            boolean not null default false,
  unlocked_at            timestamptz,

  deleted_at             timestamptz,

  constraint unlocked_at_set_when_unlocked
    check (not is_unlocked or unlocked_at is not null)
);

comment on column public.events.host_token is
  'Independently generated 256-bit secret. Never derived from guest_token - leaking the join link must not grant host powers.';
comment on column public.events.unlocked_at is
  'Effective reveal moment. Retention deadline = coalesce(unlocked_at, unlock_at) + retention_days.';
comment on column public.events.storage_used_bytes is
  'Authoritative running total, incremented only on confirmed upload. Guards max_storage_bytes.';

-- ============================================================
-- guest_sessions
-- A session is not a person: no PII beyond what the photos themselves carry.
-- ============================================================
create table public.guest_sessions (
  id             uuid primary key default gen_random_uuid(),
  event_id       uuid not null references public.events(id) on delete cascade,
  created_at     timestamptz not null default now(),
  last_seen_at   timestamptz not null default now(),
  -- authoritative per-guest counter; the client-side mirror is UI-only
  upload_count   int not null default 0 check (upload_count >= 0),
  -- GDPR evidence that the guest saw and accepted the camera notice
  consent_ack_at timestamptz
);

create index guest_sessions_event_id_idx on public.guest_sessions (event_id);

-- ============================================================
-- media_items
-- ============================================================
create table public.media_items (
  id               uuid primary key default gen_random_uuid(),
  event_id         uuid not null references public.events(id) on delete cascade,
  guest_session_id uuid not null references public.guest_sessions(id) on delete cascade,
  storage_path     text not null unique,
  media_type       text not null check (media_type in ('photo', 'video')),
  mime_type        text not null,
  size_bytes       bigint not null check (size_bytes >= 0),
  -- product cap is 15s; 16 leaves room for container duration rounding
  duration_seconds numeric(5, 2) check (duration_seconds is null or duration_seconds <= 16),
  exif_stripped    boolean not null default false,
  -- pending: upload URL issued, not yet confirmed. Swept after 1h if abandoned.
  status           text not null default 'pending'
                     check (status in ('pending', 'confirmed', 'deleted')),
  created_at       timestamptz not null default now(),
  deleted_at       timestamptz,

  constraint duration_only_for_video
    check (media_type = 'video' or duration_seconds is null)
);

create index media_items_event_confirmed_idx
  on public.media_items (event_id) where status = 'confirmed';
create index media_items_guest_session_id_idx
  on public.media_items (guest_session_id);
create index media_items_pending_idx
  on public.media_items (created_at) where status = 'pending';

-- ============================================================
-- Row Level Security: default-deny everywhere.
--
-- No policies exist for anon/authenticated, so RLS denies them everything,
-- and privileges are revoked on top, blocking access at two independent
-- layers. All app access goes through Next.js route handlers using the
-- service_role key, which bypasses RLS by design. This is defense-in-depth
-- against a future direct-from-browser query, not the primary gate.
-- ============================================================
alter table public.events enable row level security;
alter table public.guest_sessions enable row level security;
alter table public.media_items enable row level security;

revoke all on public.events from anon, authenticated;
revoke all on public.guest_sessions from anon, authenticated;
revoke all on public.media_items from anon, authenticated;
