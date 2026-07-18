"use client"

import Link from "next/link"
import { useCallback, useEffect, useRef, useState } from "react"

import { buttonStyles } from "@/components/ui/Button"

import { useEventMedia } from "./useEventMedia"

/**
 * The payoff: the roll, on the big screen, running itself.
 *
 * This is the one view that has to survive being left alone for hours in front
 * of a room, and that drives every decision in it:
 *
 *   It keeps polling. Guests go on shooting after the unlock — nothing about
 *   the reveal closes the camera — so the show grows through the night. New
 *   shots land at the end of the roll and come up on screen in their turn.
 *
 *   It holds a wake lock. A laptop that dims after 30 seconds turns the
 *   centrepiece of the party into a black rectangle.
 *
 *   Videos are muted. A slideshow that unmutes itself over a room with a DJ and
 *   a hundred conversations is a jump-scare, not a feature. The gallery is
 *   where the host watches a clip with its sound.
 */

const PHOTO_DURATION_MS = 6_000
const POLL_MS = 30_000

// If 'ended' never arrives — a truncated clip, a codec the browser half-knows —
// the show must not stop dead in front of everyone. Give the clip its own length
// plus a little, then move on regardless.
const VIDEO_FALLBACK_MARGIN_MS = 3_000
const VIDEO_ASSUMED_SECONDS = 15

export function Slideshow({ hostToken }: { hostToken: string }) {
  const state = useEventMedia(hostToken, { pollMs: POLL_MS })
  const [index, setIndex] = useState(0)
  const [paused, setPaused] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  const count = state.status === "ready" ? state.items.length : 0

  /**
   * The roll changes size underneath a running show: it grows as guests keep
   * shooting, and it can shrink on a delete or the retention sweep. So the
   * index is clamped wherever it is read rather than corrected into state —
   * storing the correction back would only be an extra render to say what this
   * already says, and every step below wraps against the live count so the
   * newest shots are never skipped.
   */
  const clamp = useCallback(
    (value: number) => (count === 0 ? 0 : Math.min(value, count - 1)),
    [count],
  )

  const advance = useCallback(() => {
    setIndex((value) => (count === 0 ? 0 : (clamp(value) + 1) % count))
  }, [count, clamp])

  // Keep the screen awake. Best-effort by design: a refusal is not worth
  // telling the host about — the show runs either way, it may just dim on a
  // machine we could not reach.
  useEffect(() => {
    if (typeof navigator === "undefined" || !("wakeLock" in navigator)) return

    let sentinel: WakeLockSentinel | null = null
    let cancelled = false

    async function acquire() {
      try {
        const lock = await navigator.wakeLock.request("screen")
        if (cancelled) {
          void lock.release()
          return
        }
        sentinel = lock
      } catch {
        // Denied, or the tab was not visible. The visibility handler retries.
      }
    }

    // The browser drops the lock whenever the tab is hidden and does not hand
    // it back on its own, so re-take it every time we are looked at again.
    function handleVisibility() {
      if (document.visibilityState === "visible") void acquire()
    }

    void acquire()
    document.addEventListener("visibilitychange", handleVisibility)

    return () => {
      cancelled = true
      document.removeEventListener("visibilitychange", handleVisibility)
      void sentinel?.release()
    }
  }, [])

  const safeIndex = clamp(index)
  const current = state.status === "ready" ? state.items[safeIndex] : undefined

  // Auto-advance. A photo gets a fixed beat; a video gets however long it runs.
  useEffect(() => {
    if (paused || !current) return

    if (current.mediaType === "photo") {
      const timer = setTimeout(advance, PHOTO_DURATION_MS)
      return () => clearTimeout(timer)
    }

    const seconds = current.durationSeconds ?? VIDEO_ASSUMED_SECONDS
    const timer = setTimeout(advance, seconds * 1000 + VIDEO_FALLBACK_MARGIN_MS)
    return () => clearTimeout(timer)
  }, [current, paused, advance])

  useEffect(() => {
    function handleKey(event: KeyboardEvent) {
      if (event.key === " ") {
        // Space scrolls the page by default, which is not what anyone means when
        // they hit it standing in front of a slideshow.
        event.preventDefault()
        setPaused((value) => !value)
      }
      if (event.key === "ArrowRight") advance()
      if (event.key === "ArrowLeft") {
        setIndex((value) => (count === 0 ? 0 : (clamp(value) - 1 + count) % count))
      }
    }
    window.addEventListener("keydown", handleKey)
    return () => window.removeEventListener("keydown", handleKey)
  }, [advance, clamp, count])

  if (state.status === "loading") return <Centered>Loading…</Centered>
  if (state.status === "locked") {
    return (
      <Centered>
        <p className="font-medium text-ink">Still sealed</p>
        <p className="mt-1 text-sm text-ink-dim">
          Unlock the event first — there is nothing to show yet.
        </p>
        <Link href={`/host/${hostToken}`} className={`${buttonStyles("quiet")} mt-4`}>
          Back to the dashboard
        </Link>
      </Centered>
    )
  }
  if (state.status === "gone") return <Centered>This event no longer exists.</Centered>
  if (state.status === "error") return <Centered>{state.message}</Centered>
  if (state.items.length === 0) return <Centered>Nobody has taken a shot yet.</Centered>
  if (!current) return <Centered>Loading…</Centered>

  return (
    <div ref={containerRef} className="relative h-dvh w-full bg-black">
      <button
        type="button"
        onClick={() => setPaused((value) => !value)}
        className="absolute inset-0 z-10 h-full w-full"
        aria-label={paused ? "Resume" : "Pause"}
      />

      {/* A way out. The tap-anywhere pause covers the whole screen, so on a
          phone there is otherwise no route back to the dashboard — sits above
          it with its own pointer-events so the tap lands on the link, not the
          pause. */}
      <Link
        href={`/host/${hostToken}`}
        className="absolute left-4 top-4 z-20 rounded bg-black/50 px-3 py-1.5 text-xs text-white/50 transition-opacity hover:text-white/90"
      >
        ← Back
      </Link>

      {current.mediaType === "video" ? (
        <video
          // key remounts the element per clip: reusing it leaves the previous
          // video playing underneath the new source.
          key={current.id}
          src={current.url}
          className="h-full w-full object-contain"
          autoPlay
          muted
          playsInline
          onEnded={advance}
        />
      ) : (
        /* eslint-disable-next-line @next/next/no-img-element -- signed, short-lived URL on another origin: next/image cannot fetch it, and must not cache it */
        <img
          key={current.id}
          src={current.url}
          alt=""
          className="h-full w-full object-contain"
        />
      )}

      {/* Chrome over a photograph in front of a room: as close to absent as it
          can be while still being findable. White at 40% rather than a room
          token — this floats over whatever the photo happens to be, not over
          the darkroom, so it cannot borrow the room's contrast. */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex items-center justify-between p-4 text-xs text-white/40">
        <span className="numeric">
          {safeIndex + 1} / {state.items.length}
        </span>
        {paused && <span className="text-white/70">Paused</span>}
        <button
          type="button"
          onClick={() => void containerRef.current?.requestFullscreen?.()}
          className="pointer-events-auto rounded bg-black/50 px-2 py-1 transition-opacity hover:text-white/90"
        >
          Fullscreen
        </button>
      </div>
    </div>
  )
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center px-6 text-center text-ink-dim">
      {children}
    </div>
  )
}
