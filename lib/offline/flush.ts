"use client"

import {
  UploadRejectedError,
  confirmUpload,
  reserveAndPut,
} from "@/components/camera/uploadCapture"

import {
  type QueuedCapture,
  claimNext,
  isQueueSupported,
  markUploaded,
  release,
  remove,
  resetUpload,
  toCapture,
} from "./uploadQueue"

/**
 * Emptying the queue, once the network comes back.
 *
 * Two rules hold everything else up:
 *
 *   1. One shot is claimed at a time, and a claim is a database transaction.
 *      Nothing here runs in parallel — a phone that just found one bar of
 *      signal is not helped by three simultaneous uploads, and serialising
 *      means a failure stops the rest rather than spraying half of them at a
 *      network that is clearly not ready.
 *   2. A rejection is not a failure to retry. The server saying "you have used
 *      all your shots" will say it again in an hour; the guest needs to hear
 *      it, not have their phone repeat the question all night. Only a genuine
 *      network fault leaves the shot queued.
 */

export type FlushOutcome = {
  /** Shots that made it up and are now the host's. */
  uploaded: number
  /**
   * Shots the server refused for good — out of quota, too large, unreadable.
   * They are gone from the queue and the guest is owed an explanation, so the
   * errors are passed through whole rather than flattened to a count: they
   * already carry both the sentence to show and the code the capture screen
   * needs to correct its own idea of how many shots are left.
   */
  rejected: UploadRejectedError[]
  /** Still no usable network. Whatever is left is still queued and safe. */
  stalled: boolean
}

const EMPTY: FlushOutcome = { uploaded: 0, rejected: [], stalled: false }

/**
 * Run one queued shot to completion, resuming wherever it left off.
 *
 * The `attempt` loop exists for one specific liar: a PUT that reported success
 * over bytes that are not in the bucket. Confirm answers `object_missing`, and
 * rather than lose the photo we forget the reservation and run the whole
 * upload again from init — once. The reservation left behind can never be
 * confirmed (its object really is missing), so it costs the guest nothing and
 * the nightly sweep collects it.
 */
async function sendQueued(item: QueuedCapture): Promise<void> {
  let mediaId = item.mediaId

  for (let attempt = 0; attempt < 2; attempt++) {
    if (mediaId === null) {
      mediaId = await reserveAndPut(item.guestToken, toCapture(item))
      // Written before confirm is attempted, not after. If the tab dies in the
      // next millisecond the bytes are still up there, and the record of that
      // is what stops the next flush from uploading them a second time.
      await markUploaded(item.id, mediaId)
    }

    try {
      await confirmUpload(item.guestToken, mediaId)
      return
    } catch (error) {
      const missing = error instanceof UploadRejectedError && error.code === "object_missing"
      if (!missing || attempt === 1) throw error
      await resetUpload(item.id)
      mediaId = null
    }
  }
}

async function drain(guestToken: string): Promise<FlushOutcome> {
  if (!isQueueSupported()) return EMPTY

  const outcome: FlushOutcome = { uploaded: 0, rejected: [], stalled: false }

  for (;;) {
    const item = await claimNext(guestToken)
    if (!item) return outcome

    try {
      await sendQueued(item)
      await remove(item.id)
      outcome.uploaded += 1
    } catch (error) {
      if (error instanceof UploadRejectedError) {
        // It will never be accepted, so keeping it would be keeping a promise
        // we cannot honour. Drop it and say why.
        await remove(item.id)
        outcome.rejected.push(error)
        continue
      }
      // Network, or something we did not foresee. Either way the shot stays,
      // and we stop: whatever broke this upload will break the next one.
      await release(item.id)
      outcome.stalled = true
      return outcome
    }
  }
}

let inFlight: Promise<FlushOutcome> | null = null

async function guarded(guestToken: string): Promise<FlushOutcome> {
  try {
    return await drain(guestToken)
  } finally {
    inFlight = null
  }
}

/**
 * Empty the queue, or join the attempt already under way.
 *
 * The triggers overlap by design — the tab regains connectivity, the guest
 * taps retry, the page reloads — and without this they would overlap in the
 * queue too. The claim in IndexedDB would still stop a double upload across
 * tabs; this stops the pointless work inside one.
 */
export function flushQueue(guestToken: string): Promise<FlushOutcome> {
  inFlight ??= guarded(guestToken)
  return inFlight
}
