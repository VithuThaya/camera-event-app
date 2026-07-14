"use client"

import { type DBSchema, type IDBPDatabase, openDB } from "idb"

import type { Capture } from "@/components/camera/uploadCapture"

/**
 * Where a shot waits out a dead spot.
 *
 * The premise of the app is that a guest gets a handful of shots and every one
 * of them counts. A cellar, a marquee, a stone church — the places people take
 * the best photos are exactly the places with no bars. Losing the shot there is
 * losing the shot, so it goes to disk the moment the network refuses it, and
 * the guest is told the truth: it is safe, it will go up, they can keep
 * shooting.
 *
 * What is stored is the *capture*, never the reservation. A signed upload URL
 * expires in 60 seconds, so a queue that persisted one would be persisting
 * rubbish for any retry worth the name. The bytes, and what they are, is all a
 * later attempt needs to run the whole upload again from the top.
 */

const DB_NAME = "weddingphoto-uploads"
const DB_VERSION = 1
const STORE = "captures"

/**
 * How long a claim is believed before another flusher may take the item back.
 *
 * This only ever matters when a flush dies without releasing — the tab was
 * killed mid-upload — because every ordinary failure releases on its way out.
 * Long enough that a 40 MB clip crawling over party wifi is never mistaken for
 * a corpse; short enough that a guest who force-quit and came back is not told
 * to wait half an hour.
 */
export const CLAIM_LEASE_MS = 5 * 60 * 1000

export type QueuedCapture = {
  id: string
  guestToken: string
  /**
   * The bytes, not a Blob.
   *
   * Blobs are structured-cloneable and IndexedDB accepts them, so this looks
   * like a needless copy — but a Blob is a *reference* to storage the browser
   * manages, and WebKit has a long history of handing back Blobs that are
   * detached or empty once the page that created them is gone. That is the
   * exact moment this queue exists to survive, and a silently empty Blob would
   * present as a lost photo rather than as an error. An ArrayBuffer is the
   * bytes themselves, and it round-trips through a reload on every engine.
   */
  bytes: ArrayBuffer
  mediaType: "photo" | "video"
  mimeType: string
  durationSeconds?: number
  capturedAt: number
  /**
   * Set only once the bytes are provably in the bucket, which is what makes it
   * meaningful: non-null reads as "uploaded, awaiting confirm" and nothing
   * else. Null means start over from init — which costs the guest nothing,
   * since no counter moves before confirm.
   */
  mediaId: string | null
  claimedAt: number | null
}

interface QueueDB extends DBSchema {
  captures: {
    key: string
    value: QueuedCapture
    indexes: { capturedAt: number }
  }
}

/**
 * Private mode on older WebKit, and a handful of hardened configurations, have
 * no usable IndexedDB. Callers fall back to the pre-queue behaviour — the shot
 * stays in memory and Keep can be tapped again — which is worse, but honest.
 */
export function isQueueSupported(): boolean {
  return typeof indexedDB !== "undefined"
}

let dbPromise: Promise<IDBPDatabase<QueueDB>> | null = null

function open(): Promise<IDBPDatabase<QueueDB>> {
  dbPromise ??= openDB<QueueDB>(DB_NAME, DB_VERSION, {
    upgrade(db) {
      const store = db.createObjectStore(STORE, { keyPath: "id" })
      // Oldest first. A guest's shots go up in the order they were taken,
      // which is the order they will be looked at.
      store.createIndex("capturedAt", "capturedAt")
    },
  })
  return dbPromise
}

/** The write failed — almost always because the device is out of room. */
export class QueueWriteError extends Error {}

export async function enqueue(guestToken: string, capture: Capture): Promise<QueuedCapture> {
  const item: QueuedCapture = {
    id: crypto.randomUUID(),
    guestToken,
    bytes: await capture.blob.arrayBuffer(),
    mediaType: capture.mediaType,
    mimeType: capture.mimeType,
    durationSeconds: capture.durationSeconds,
    capturedAt: Date.now(),
    mediaId: null,
    claimedAt: null,
  }
  try {
    const db = await open()
    await db.put(STORE, item)
  } catch (error) {
    // Never swallowed. The caller is holding the only copy of this photo, in
    // memory, and telling them it is safe when it is not is the one lie this
    // module must never tell.
    throw new QueueWriteError(
      error instanceof Error ? error.message : "Could not save the shot",
    )
  }
  return item
}

/**
 * Take the oldest unclaimed shot and mark it ours, in one transaction.
 *
 * The read and the write cannot be separated. Two tabs — or a tab and an
 * `online` handler that fired while a flush was already running — would
 * otherwise both see the same item unclaimed and both upload it, and since
 * `init` reserves a fresh row per call, that spends two of the guest's shots
 * on one photo. IndexedDB serialises readwrite transactions on a store, so
 * whoever commits first gets the item and the loser sees the claim.
 */
export async function claimNext(guestToken: string): Promise<QueuedCapture | null> {
  const db = await open()
  const tx = db.transaction(STORE, "readwrite")
  const now = Date.now()
  let claimed: QueuedCapture | null = null

  let cursor = await tx.store.index("capturedAt").openCursor()
  while (cursor) {
    const item = cursor.value
    const free = item.claimedAt === null || now - item.claimedAt > CLAIM_LEASE_MS
    if (item.guestToken === guestToken && free) {
      claimed = { ...item, claimedAt: now }
      await cursor.update(claimed)
      break
    }
    cursor = await cursor.continue()
  }

  await tx.done
  return claimed
}

/** Hand it back unfinished, so the next flush picks it up straight away. */
export async function release(id: string): Promise<void> {
  const db = await open()
  const tx = db.transaction(STORE, "readwrite")
  const item = await tx.store.get(id)
  if (item) await tx.store.put({ ...item, claimedAt: null })
  await tx.done
}

/**
 * Record that the bytes are up. From here the item is resumable at confirm and
 * must never be uploaded again, which is why this is written before confirm is
 * so much as attempted.
 */
export async function markUploaded(id: string, mediaId: string): Promise<void> {
  const db = await open()
  const tx = db.transaction(STORE, "readwrite")
  const item = await tx.store.get(id)
  if (item) await tx.store.put({ ...item, mediaId })
  await tx.done
}

/**
 * Forget the reservation but keep the shot: the bytes never reached the bucket
 * after all, so the next attempt has to start from init. The row this leaves
 * behind server-side can never be confirmed, and is swept within the day.
 *
 * The claim is deliberately left alone. Whoever is holding this item is still
 * working on it, and handing it to a second flusher mid-restart is exactly the
 * double-upload this queue takes such care to prevent. Releasing is a separate
 * decision, made by whoever gives up.
 */
export async function resetUpload(id: string): Promise<void> {
  const db = await open()
  const tx = db.transaction(STORE, "readwrite")
  const item = await tx.store.get(id)
  if (item) await tx.store.put({ ...item, mediaId: null })
  await tx.done
}

export async function remove(id: string): Promise<void> {
  const db = await open()
  await db.delete(STORE, id)
}

export async function countQueued(guestToken: string): Promise<number> {
  if (!isQueueSupported()) return 0
  const db = await open()
  const all = await db.getAll(STORE)
  return all.filter((item) => item.guestToken === guestToken).length
}

/** Back into the shape the upload path already speaks. */
export function toCapture(item: QueuedCapture): Capture {
  return {
    blob: new Blob([item.bytes], { type: item.mimeType }),
    mediaType: item.mediaType,
    mimeType: item.mimeType,
    durationSeconds: item.durationSeconds,
  }
}
