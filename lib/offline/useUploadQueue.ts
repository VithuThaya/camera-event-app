"use client"

import { useCallback, useEffect, useRef, useState } from "react"

import type { Capture, UploadRejectedError } from "@/components/camera/uploadCapture"

import { type FlushOutcome, flushQueue } from "./flush"
import { QueueWriteError, countQueued, enqueue, isQueueSupported } from "./uploadQueue"

/**
 * The queue, as the capture screen sees it.
 *
 * Three triggers, because no single one is trustworthy on the phones this has
 * to work on:
 *
 *   - `online` is the obvious one and the least reliable. It fires when the
 *     browser thinks it has a network, which on a phone drifting between a
 *     saturated venue wifi and 4G is not the same as having one.
 *   - `visibilitychange` catches the guest coming back to the tab. On iOS this
 *     is the trigger that actually does the work: Safari freezes background
 *     tabs hard, and an `online` event that fired while the phone was in a
 *     pocket may never be delivered.
 *   - Mounting covers the reload — a tab that was discarded and reopened, or a
 *     guest who scanned the QR again an hour later.
 *
 * They overlap constantly, and that is fine. flushQueue() collapses concurrent
 * calls, and the claim in IndexedDB makes even a genuine race harmless.
 *
 * There is deliberately no timer. A phone with no signal polling every ten
 * seconds is a phone with a flat battery, and nothing here is urgent enough to
 * cost a guest their evening.
 */

export type UploadQueue = {
  /** Shots waiting. Counts against the guest's allowance in the UI mirror. */
  queuedCount: number
  flushing: boolean
  /** Explanations owed to the guest from the last flush. Empty is the norm. */
  rejected: UploadRejectedError[]
  /** False when the shot could not be saved — the caller must not claim it was. */
  queue: (capture: Capture) => Promise<boolean>
  flushNow: () => void
  dismissRejected: () => void
}

/**
 * @param onFlushed Called once a flush actually moved something. The capture
 *   screen owns the "shots used" mirror and cannot see a flush happen from the
 *   outside — a queued shot going up without moving that number would hand the
 *   guest a free extra shot the server will refuse, and a shot rejected for
 *   spent quota means the mirror was already wrong. Both are consequences of
 *   this event, so they are reported as one rather than reconstructed from
 *   state afterwards.
 */
export function useUploadQueue(
  guestToken: string,
  onFlushed?: (outcome: FlushOutcome) => void,
): UploadQueue {
  // Held in a ref so a caller passing an inline arrow does not re-subscribe
  // every listener on every render. Written in an effect, not during render:
  // a ref is not rendered state and React reserves the right to throw a render
  // away, which would leave this pointing at a callback from a pass that never
  // happened.
  const onFlushedRef = useRef(onFlushed)
  useEffect(() => {
    onFlushedRef.current = onFlushed
  })

  // Starts at zero on both the server and the first client pass, which is why
  // it can be rendered directly: there is nothing to mismatch. The real count
  // arrives from IndexedDB a moment later, on mount.
  const [queuedCount, setQueuedCount] = useState(0)
  const [flushing, setFlushing] = useState(false)
  const [rejected, setRejected] = useState<UploadRejectedError[]>([])

  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const refresh = useCallback(async () => {
    const count = await countQueued(guestToken)
    if (alive.current) setQueuedCount(count)
  }, [guestToken])

  const flushNow = useCallback(() => {
    void (async () => {
      if (alive.current) setFlushing(true)
      try {
        const outcome = await flushQueue(guestToken)
        if (outcome.uploaded > 0 || outcome.rejected.length > 0) {
          onFlushedRef.current?.(outcome)
        }
        if (alive.current && outcome.rejected.length > 0) setRejected(outcome.rejected)
      } finally {
        if (alive.current) setFlushing(false)
        await refresh()
      }
    })()
  }, [guestToken, refresh])

  const queue = useCallback(
    async (capture: Capture): Promise<boolean> => {
      if (!isQueueSupported()) return false
      try {
        await enqueue(guestToken, capture)
      } catch (error) {
        // Out of room on the device, most likely. The caller still holds the
        // photo and will say so; what it must not do is claim it is saved.
        if (error instanceof QueueWriteError) return false
        throw error
      }
      await refresh()
      return true
    },
    [guestToken, refresh],
  )

  useEffect(() => {
    void refresh()

    const attempt = () => {
      // Asking first costs nothing and saves a pointless trip through the whole
      // claim machinery every time a tab is merely looked at.
      if (navigator.onLine) flushNow()
    }

    attempt()

    const onVisible = () => {
      if (document.visibilityState === "visible") attempt()
    }

    window.addEventListener("online", flushNow)
    document.addEventListener("visibilitychange", onVisible)
    return () => {
      window.removeEventListener("online", flushNow)
      document.removeEventListener("visibilitychange", onVisible)
    }
  }, [refresh, flushNow])

  const dismissRejected = useCallback(() => setRejected([]), [])

  return { queuedCount, flushing, rejected, queue, flushNow, dismissRejected }
}
