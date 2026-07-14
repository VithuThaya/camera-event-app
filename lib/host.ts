import "server-only"

import { isEventUnlocked, unlockMoment } from "./events"
import { MEDIA_BUCKET } from "./storagePaths"
import { supabaseAdmin } from "./supabase/server"
import type { EventRow } from "./supabase/types"
import { isWellFormedHostToken } from "./tokens"

/**
 * Host access, resolved in one place.
 *
 * The host token in the URL is the credential. There is no host cookie, and
 * that is deliberate: every host request already carries the token in its
 * path, so a cookie could not be a second factor — anyone able to send one
 * request could mint the cookie too. What a cookie *would* add is a CSRF
 * surface, since a cookie-authenticated POST can be forged by any page the
 * host happens to visit, while a credential that lives only in the URL cannot
 * be forged by someone who does not already hold it. It would also outlive the
 * tab: a 30-day cookie left on the party laptop is a worse leak than the URL
 * it replaced.
 *
 * So every host route re-reads the token and re-checks the event against the
 * database. There is no session to go stale and no state to drift out of step.
 */

/**
 * How long a host's view URL stays good.
 *
 * An hour, not the 60s used for uploads. These URLs back a slideshow that runs
 * for the length of a party; a minute-long URL would blank the screen mid-show.
 * The exposure is bounded the same way either way — the URL points at one
 * object, in a private bucket, and is only ever minted after the reveal.
 */
export const MEDIA_URL_TTL_SECONDS = 60 * 60

export async function findEventByHostToken(
  token: string,
): Promise<EventRow | null> {
  // Reject a malformed token before spending a round-trip, and answer it the
  // same way as an unknown one.
  if (!isWellFormedHostToken(token)) return null

  const { data, error } = await supabaseAdmin()
    .from("events")
    .select("*")
    .eq("host_token", token)
    .is("deleted_at", null)
    .maybeSingle()

  if (error) {
    console.error("Failed to look up event by host token:", error)
    // Fail closed: an unreadable event is not an accessible one.
    return null
  }
  if (!data || data.status === "deleted") return null

  // 'archived' is deliberately still reachable. The retention sweep empties the
  // bucket but leaves the event, and a host who arrives after the deadline
  // deserves to be told their media is gone rather than shown a flat 404 that
  // looks like they mistyped their own link.
  return data
}

export type HostGate =
  | { ok: true; event: EventRow }
  | { ok: false; reason: "not_found" | "locked" }

/**
 * The reveal gate for every host route that serves media.
 *
 * Gallery, slideshow and download-all all come through here, so the check
 * cannot be present in two of them and forgotten in the third. It defers to
 * isEventUnlocked() in lib/events.ts rather than re-deriving the rule.
 *
 * The host is gated by their own unlock even though they are the one who can
 * lift it. That is the point: the reveal must cost a deliberate, recorded act
 * (unlocked_at gets stamped, and the retention clock starts from it) instead of
 * quietly happening the first time the host opens the gallery. Guests are told
 * nothing is visible until unlock; this is what makes that true rather than
 * merely polite.
 */
export async function gateHostMedia(token: string): Promise<HostGate> {
  const event = await findEventByHostToken(token)
  if (!event) return { ok: false, reason: "not_found" }
  if (!isEventUnlocked(event)) return { ok: false, reason: "locked" }
  return { ok: true, event }
}

export type HostMediaItem = {
  id: string
  mediaType: string
  mimeType: string
  sizeBytes: number
  durationSeconds: number | null
  createdAt: string
  url: string
}

type ConfirmedRow = {
  id: string
  storage_path: string
  media_type: string
  mime_type: string
  size_bytes: number
  duration_seconds: number | null
  created_at: string
}

/**
 * Every confirmed shot, oldest first, each with a signed URL.
 *
 * Chronological is the only ordering that means anything here: it is the order
 * the night actually happened, which is what a slideshow wants and what a grid
 * reads best as.
 *
 * Only 'confirmed' rows are ever returned. A 'pending' row is an upload that
 * was reserved but never finished — its object may not exist at all, and it is
 * not one of the guest's kept shots.
 */
export async function listConfirmedMedia(
  eventId: string,
): Promise<HostMediaItem[] | null> {
  const { data, error } = await supabaseAdmin()
    .from("media_items")
    .select(
      "id, storage_path, media_type, mime_type, size_bytes, duration_seconds, created_at",
    )
    .eq("event_id", eventId)
    .eq("status", "confirmed")
    .is("deleted_at", null)
    .order("created_at", { ascending: true })

  if (error) {
    console.error("Failed to list confirmed media:", error)
    return null
  }

  const rows = (data ?? []) as ConfirmedRow[]
  if (rows.length === 0) return []

  const { data: signed, error: signError } = await supabaseAdmin()
    .storage.from(MEDIA_BUCKET)
    .createSignedUrls(
      rows.map((row) => row.storage_path),
      MEDIA_URL_TTL_SECONDS,
    )

  if (signError || !signed) {
    console.error("Failed to sign media URLs:", signError)
    return null
  }

  // createSignedUrls reports failure per path rather than throwing, so an
  // object that cannot be signed comes back as an entry with a null URL. Drop
  // those rather than ship a broken <img> to the host: such an object is one
  // the retention sweep already took, or one that never really landed.
  const urlByPath = new Map<string, string>()
  for (const entry of signed) {
    if (entry.signedUrl && entry.path) urlByPath.set(entry.path, entry.signedUrl)
  }

  return rows.flatMap((row) => {
    const url = urlByPath.get(row.storage_path)
    if (!url) return []
    return [
      {
        id: row.id,
        mediaType: row.media_type,
        mimeType: row.mime_type,
        sizeBytes: row.size_bytes,
        durationSeconds: row.duration_seconds,
        createdAt: row.created_at,
        url,
      },
    ]
  })
}

/**
 * The counts behind the dashboard.
 *
 * guest_sessions counts everyone who accepted the notice, not everyone who
 * opened the link — a session with no consent never got as far as the camera,
 * so counting it would tell the host they have guests they do not have.
 */
async function loadHostStats(eventId: string): Promise<{
  guestCount: number
  shotCount: number
} | null> {
  const [guests, shots] = await Promise.all([
    supabaseAdmin()
      .from("guest_sessions")
      .select("id", { count: "exact", head: true })
      .eq("event_id", eventId)
      .not("consent_ack_at", "is", null),
    supabaseAdmin()
      .from("media_items")
      .select("id", { count: "exact", head: true })
      .eq("event_id", eventId)
      .eq("status", "confirmed"),
  ])

  if (guests.error || shots.error) {
    console.error("Failed to load host stats:", guests.error ?? shots.error)
    return null
  }

  return { guestCount: guests.count ?? 0, shotCount: shots.count ?? 0 }
}

/**
 * When the media disappears, or null while the event is still locked.
 *
 * The clock starts at the reveal, not at creation — an event made in January
 * and unlocked in June keeps its media until June plus retention_days. The
 * Phase 4 sweep must read the same unlock moment, or the countdown the host
 * sees will promise a date the sweep disagrees with.
 */
export function retentionDeadline(
  event: Pick<EventRow, "retention_days">,
  unlockedAt: Date | null,
): Date | null {
  if (!unlockedAt) return null
  const deadline = new Date(unlockedAt)
  deadline.setUTCDate(deadline.getUTCDate() + event.retention_days)
  return deadline
}

export type HostDashboard = {
  name: string
  createdAt: string
  status: string
  guestToken: string
  limits: {
    maxGuests: number
    maxUploadsPerGuest: number
    maxStorageBytes: number
    retentionDays: number
  }
  usage: {
    guestCount: number
    shotCount: number
    storageUsedBytes: number
  }
  unlock: {
    revealed: boolean
    unlockAt: string | null
    unlockedAt: string | null
  }
  retention: {
    deadline: string | null
  }
}

/**
 * Everything the dashboard shows, built once.
 *
 * Both the server-rendered page and the polling API route return this, so a
 * host cannot see one set of numbers on load and a different shape a few
 * seconds later when the first poll lands.
 *
 * host_token is deliberately absent. It is already in the URL of whatever
 * request asked for this, and a second copy in a JSON body is a copy that comes
 * to rest in places a URL does not.
 */
export async function buildHostDashboard(
  event: EventRow,
): Promise<HostDashboard | null> {
  const stats = await loadHostStats(event.id)
  if (!stats) return null

  return {
    name: event.name,
    createdAt: event.created_at,
    status: event.status,
    // The host's own join link, so they can re-share it without digging up the
    // message they sent themselves.
    guestToken: event.guest_token,
    limits: {
      maxGuests: event.max_guests,
      maxUploadsPerGuest: event.max_uploads_per_guest,
      maxStorageBytes: event.max_storage_bytes,
      retentionDays: event.retention_days,
    },
    usage: {
      guestCount: stats.guestCount,
      shotCount: stats.shotCount,
      storageUsedBytes: event.storage_used_bytes,
    },
    unlock: {
      // The computed answer, not the raw column: a scheduled reveal that has
      // passed reads as revealed even though is_unlocked is still false. The
      // dashboard has to agree with the gate the media routes enforce, or it
      // will draw a lock over an open door.
      revealed: isEventUnlocked(event),
      unlockAt: event.unlock_at,
      unlockedAt: event.unlocked_at,
    },
    retention: {
      deadline: retentionDeadline(event, unlockMoment(event))?.toISOString() ?? null,
    },
  }
}
