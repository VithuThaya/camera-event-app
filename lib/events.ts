import "server-only"

import { readGuestSession } from "./session"
import { supabaseAdmin } from "./supabase/server"
import type { EventRow } from "./supabase/types"
import { isWellFormedGuestToken } from "./tokens"

/**
 * Shared event lookups. The guest page and the guest API routes both need
 * these, and they must agree — a page that shows the capture UI while the API
 * rejects the upload is worse than either failing alone.
 */

export async function findActiveEventByGuestToken(
  token: string,
): Promise<EventRow | null> {
  // Reject a malformed token before spending a database round-trip. Callers
  // must answer this the same way they answer an unknown token.
  if (!isWellFormedGuestToken(token)) return null

  const { data, error } = await supabaseAdmin()
    .from("events")
    .select("*")
    .eq("guest_token", token)
    .eq("status", "active")
    .is("deleted_at", null)
    .maybeSingle()

  if (error) {
    console.error("Failed to look up event by guest token:", error)
    return null
  }
  return data
}

export async function countGuestSessions(eventId: string): Promise<number> {
  const { count, error } = await supabaseAdmin()
    .from("guest_sessions")
    .select("id", { count: "exact", head: true })
    .eq("event_id", eventId)

  if (error) {
    console.error("Failed to count guest sessions:", error)
    // Fail closed: an unknown count must not read as "room for one more".
    return Number.POSITIVE_INFINITY
  }
  return count ?? 0
}

/**
 * Who is allowed to upload, resolved in one place.
 *
 * Both upload routes need the same four facts to line up: the token names a
 * live event, the caller carries a session cookie for *that* event, the row
 * behind the cookie still exists, and consent was actually recorded. Spreading
 * these across two routes is how one of them ends up missing a check.
 *
 * Everything here fails as "not found" rather than explaining which condition
 * failed: an attacker holding a guest token learns nothing about whether an
 * event exists, and a guest with a stale cookie gets the same answer either
 * way. The pages redirect to the join screen, which is where a real guest with
 * a stale cookie needs to go anyway.
 */
export type ConsentedGuest = { event: EventRow; guestSessionId: string }

export async function findConsentedGuest(
  guestToken: string,
): Promise<ConsentedGuest | null> {
  const event = await findActiveEventByGuestToken(guestToken)
  if (!event) return null

  const session = await readGuestSession(event.id)
  if (!session) return null

  const { data, error } = await supabaseAdmin()
    .from("guest_sessions")
    .select("id, consent_ack_at")
    .eq("id", session.guestSessionId)
    .eq("event_id", event.id)
    .maybeSingle()

  if (error) {
    console.error("Failed to load guest session:", error)
    // Fail closed: an unreadable session is not a consented one.
    return null
  }
  // A cookie whose row is gone is not a session, and a session that never
  // acknowledged the camera notice must not be able to upload — that consent
  // record is the entire GDPR basis for holding the photo.
  if (!data?.consent_ack_at) return null

  return { event, guestSessionId: data.id }
}

/**
 * The reveal gate, in one place.
 *
 * The whole product hangs on this staying honest, so every caller — gallery,
 * slideshow, download, retention — must ask here rather than re-deriving it.
 * A manual unlock wins outright; otherwise a scheduled unlock_at counts once
 * it has passed.
 */
export function isEventUnlocked(
  event: Pick<EventRow, "is_unlocked" | "unlock_at">,
): boolean {
  if (event.is_unlocked) return true
  if (!event.unlock_at) return false
  return new Date(event.unlock_at).getTime() <= Date.now()
}

/**
 * When the reveal actually happened, which is what the retention clock counts
 * from. Null while the event is still locked.
 */
export function unlockMoment(
  event: Pick<EventRow, "is_unlocked" | "unlock_at" | "unlocked_at">,
): Date | null {
  if (!isEventUnlocked(event)) return null
  const stamp = event.unlocked_at ?? event.unlock_at
  return stamp ? new Date(stamp) : null
}
