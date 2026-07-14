import "server-only"

import { MEDIA_BUCKET } from "./storagePaths"
import { supabaseAdmin } from "./supabase/server"

/**
 * Removing an event's bytes from Storage.
 *
 * Two callers want this: the host deleting their event by hand, and the Phase 4
 * retention sweep. Both make the same promise — that the media is gone, not
 * merely hidden — so both must delete the same way. A second copy of this logic
 * is a second chance to get "gone" wrong.
 *
 * It works from the bucket listing rather than from media_items rows on
 * purpose. Rows are what we *believe* we stored; the listing is what is
 * actually there. Those two diverge exactly where it matters most: an upload
 * that was reserved and abandoned leaves an object whose row never reached
 * 'confirmed', and a row-driven delete would walk straight past it — leaving a
 * guest's photo, un-stripped because confirm never ran, sitting in the bucket
 * after the host was told the event was deleted.
 */

// list() returns at most 100 entries per call, so page rather than assume one
// call saw everything. A wedding can hold thousands of objects.
const LIST_PAGE_SIZE = 100

// remove() takes a batch; keep batches modest so one oversized request cannot
// fail the whole purge.
const REMOVE_BATCH_SIZE = 100

export type PurgeResult = { removed: number }

export async function purgeEventMedia(
  eventId: string,
): Promise<PurgeResult | null> {
  const folder = `events/${eventId}`
  const paths: string[] = []

  for (let offset = 0; ; offset += LIST_PAGE_SIZE) {
    const { data, error } = await supabaseAdmin()
      .storage.from(MEDIA_BUCKET)
      .list(folder, { limit: LIST_PAGE_SIZE, offset })

    if (error) {
      console.error("Failed to list event media for purge:", error)
      // Fail closed. Reporting success on a listing we could not read would
      // tell the host their media is gone while it is still sitting there.
      return null
    }
    if (!data || data.length === 0) break

    for (const entry of data) paths.push(`${folder}/${entry.name}`)
    if (data.length < LIST_PAGE_SIZE) break
  }

  for (let i = 0; i < paths.length; i += REMOVE_BATCH_SIZE) {
    const batch = paths.slice(i, i + REMOVE_BATCH_SIZE)
    const { error } = await supabaseAdmin()
      .storage.from(MEDIA_BUCKET)
      .remove(batch)

    if (error) {
      console.error("Failed to remove event media:", error)
      return null
    }
  }

  return { removed: paths.length }
}
