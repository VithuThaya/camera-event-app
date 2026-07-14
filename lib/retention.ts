import "server-only"

import { unlockMoment } from "./events"
import { retentionDeadline } from "./host"
import { purgeEventMedia } from "./purge"
import { MEDIA_BUCKET } from "./storagePaths"
import { supabaseAdmin } from "./supabase/server"
import type { EventRow } from "./supabase/types"

/**
 * The promise, kept on a timer.
 *
 * The consent notice tells every guest their photos are deleted after the
 * event. Nothing in the app makes that true except this file — it is the only
 * thing standing between "we delete it" and a bucket that quietly keeps
 * everyone's night forever.
 *
 * It does not decide *when*. The deadline comes from retentionDeadline() and
 * unlockMoment(), the same two functions the host's dashboard counts down with,
 * because a sweep with its own opinion of the date would delete media on a day
 * the host was never shown. One rule, read from both ends.
 */

/**
 * How long an upload may sit unconfirmed before it is treated as abandoned.
 *
 * Generous on purpose. A guest on a bad connection at a wedding venue may take
 * minutes to push a 15s clip, and the cost of being wrong is asymmetric: sweep
 * too early and you delete the photo out from under someone still uploading it,
 * sweep late and an orphan object waits an extra hour for the next run.
 */
export const ABANDONED_UPLOAD_AGE_MS = 60 * 60 * 1000

// remove() takes a batch; keep batches modest so one oversized request cannot
// fail the whole sweep. Same reasoning as lib/purge.ts.
const REMOVE_BATCH_SIZE = 100

export type SweepReport = {
  eventsArchived: number
  objectsRemoved: number
  abandonedCleared: number
  /** Events whose purge failed and were deliberately left for the next run. */
  eventsFailed: number
}

/**
 * Events whose deadline has passed.
 *
 * The `or` is only a pre-filter to avoid dragging every live event out of the
 * database: an event that was never unlocked has no deadline at all, and never
 * expires. The decision itself is made in JavaScript by the shared helpers
 * rather than translated into SQL — a second expression of the same rule is a
 * second thing to keep in step, and this one would be invisible until it
 * deleted something early.
 */
async function loadExpiredEvents(): Promise<EventRow[] | null> {
  const { data, error } = await supabaseAdmin()
    .from("events")
    .select("*")
    .eq("status", "active")
    .is("deleted_at", null)
    .or("is_unlocked.eq.true,unlock_at.not.is.null")

  if (error) {
    console.error("Failed to load events for the retention sweep:", error)
    // Fail closed: an unreadable list is not an empty one. Returning [] here
    // would report a clean sweep that never looked at anything.
    return null
  }

  const now = Date.now()
  return (data ?? []).filter((event) => {
    const deadline = retentionDeadline(event, unlockMoment(event))
    return deadline !== null && deadline.getTime() <= now
  })
}

/**
 * One expired event, emptied.
 *
 * Bytes first, rows second — the same order as the host's own delete, for the
 * same reason: a crash in between leaves the media gone and the paperwork for
 * the next run to finish. The other order would mark an event archived, tell
 * the host their photos were deleted, and leave them sitting in the bucket.
 *
 * Returns null rather than throwing so one unreachable event cannot stop the
 * sweep from reaching the rest.
 */
async function archiveExpiredEvent(event: EventRow): Promise<number | null> {
  const purged = await purgeEventMedia(event.id)
  if (!purged) {
    console.error(`Retention: purge failed for event ${event.id}; left for the next run.`)
    return null
  }

  const nowIso = new Date().toISOString()

  const { error: mediaError } = await supabaseAdmin()
    .from("media_items")
    .update({ status: "deleted", deleted_at: nowIso })
    .eq("event_id", event.id)
    .neq("status", "deleted")

  if (mediaError) {
    console.error(`Retention: could not mark media deleted for ${event.id}:`, mediaError)
    return null
  }

  const { error: eventError } = await supabaseAdmin()
    .from("events")
    .update({
      status: "archived",
      // The counter guards max_storage_bytes, and there is nothing left to
      // guard. Leaving it would have the dashboard report gigabytes in use over
      // an empty bucket, next to a line saying the photos are gone.
      storage_used_bytes: 0,
    })
    .eq("id", event.id)
    // Still active, expressed as a filter rather than trusted from the row read
    // at the top of the sweep. A host who deleted this event in the meantime
    // must stay deleted, not be resurrected as archived.
    .eq("status", "active")

  if (eventError) {
    console.error(`Retention: could not archive event ${event.id}:`, eventError)
    return null
  }

  return purged.removed
}

export async function sweepExpiredEvents(): Promise<{
  archived: number
  removed: number
  failed: number
} | null> {
  const expired = await loadExpiredEvents()
  if (!expired) return null

  let archived = 0
  let removed = 0
  let failed = 0

  for (const event of expired) {
    const count = await archiveExpiredEvent(event)
    if (count === null) {
      failed += 1
      continue
    }
    archived += 1
    removed += count
  }

  return { archived, removed, failed }
}

/**
 * Uploads that were reserved and never finished.
 *
 * This one is row-driven, which is the exact opposite of purgeEventMedia() —
 * and deliberately so. That function empties a whole folder because the event
 * is being destroyed and the listing is the only honest account of what is in
 * it. Here the event is alive and full of shots the host is waiting to see, so
 * the folder must not be touched wholesale; the pending row names precisely the
 * one object that has no business being there, and nothing else.
 *
 * These objects matter more than their size suggests: confirm never ran on
 * them, which means their EXIF was never stripped. An abandoned upload is the
 * one file in the bucket that may still be carrying the GPS coordinates of
 * someone's living room.
 */
export async function sweepAbandonedUploads(): Promise<{ cleared: number } | null> {
  const cutoff = new Date(Date.now() - ABANDONED_UPLOAD_AGE_MS).toISOString()

  const { data, error } = await supabaseAdmin()
    .from("media_items")
    .select("id, storage_path")
    .eq("status", "pending")
    .lt("created_at", cutoff)

  if (error) {
    console.error("Failed to load abandoned uploads:", error)
    return null
  }

  const rows = (data ?? []) as { id: string; storage_path: string }[]
  if (rows.length === 0) return { cleared: 0 }

  // Bytes first, rows second, again. A pending row usually has no object behind
  // it at all — the guest took a URL and never used it — and remove() is
  // untroubled by a path that is not there, so the two cases need no telling
  // apart.
  for (let i = 0; i < rows.length; i += REMOVE_BATCH_SIZE) {
    const batch = rows.slice(i, i + REMOVE_BATCH_SIZE)
    const { error: removeError } = await supabaseAdmin()
      .storage.from(MEDIA_BUCKET)
      .remove(batch.map((row) => row.storage_path))

    if (removeError) {
      console.error("Failed to remove abandoned upload objects:", removeError)
      // Leave the rows pending so the next run tries again. Marking them
      // deleted now would strand the objects with nothing left pointing at them.
      return null
    }
  }

  const { error: rowError } = await supabaseAdmin()
    .from("media_items")
    .update({ status: "deleted", deleted_at: new Date().toISOString() })
    .in(
      "id",
      rows.map((row) => row.id),
    )

  if (rowError) {
    console.error("Failed to mark abandoned uploads deleted:", rowError)
    return null
  }

  return { cleared: rows.length }
}

/**
 * The whole nightly job.
 *
 * The two halves are independent: a failure to reach one expired event must not
 * stop stale uploads being cleared, and vice versa. Failures are counted and
 * reported rather than thrown — the run that half-worked is still worth the
 * half it did, and whatever it could not finish is picked up tomorrow because
 * nothing here depends on having run yesterday.
 */
export async function runRetentionSweep(): Promise<SweepReport | null> {
  const events = await sweepExpiredEvents()
  const abandoned = await sweepAbandonedUploads()

  if (!events && !abandoned) return null

  return {
    eventsArchived: events?.archived ?? 0,
    objectsRemoved: events?.removed ?? 0,
    abandonedCleared: abandoned?.cleared ?? 0,
    // A half that could not run at all counts as one failure, so a report of
    // all zeros can never be mistaken for a clean night.
    eventsFailed: (events?.failed ?? 0) + (events ? 0 : 1) + (abandoned ? 0 : 1),
  }
}
