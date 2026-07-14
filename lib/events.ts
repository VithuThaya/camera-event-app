import "server-only"

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
