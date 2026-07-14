"use client"

import { useCallback, useEffect, useState } from "react"

import type { HostMediaItem } from "@/lib/host"

/**
 * Loading the roll, for both the grid and the slideshow.
 *
 * The interesting part is not the fetch, it is the expiry. Every URL in the
 * response is a signed, short-lived credential for one object, and they all die
 * together an hour after they were minted. A slideshow left running at a party
 * outlives that easily, and the failure mode is the worst kind — the screen
 * silently fills with broken images at exactly the moment everyone is watching.
 *
 * So the list refreshes itself before the URLs go stale rather than after. The
 * margin is generous because the cost of being early is one extra request, and
 * the cost of being late is the whole point of the evening.
 */

const REFRESH_MARGIN_SECONDS = 5 * 60

export type MediaState =
  | { status: "loading" }
  | { status: "locked" }
  | { status: "gone" }
  | { status: "error"; message: string }
  | { status: "ready"; eventName: string; items: HostMediaItem[] }

/**
 * Two reasons to re-fetch, and they must behave differently.
 *
 *   replace — the URLs are about to expire. Everything is adopted, including
 *             new URLs for shots already on screen. Any reload this causes is
 *             unavoidable: the old URLs are dying regardless.
 *   merge   — a poll for shots taken since we looked. Anything already known
 *             keeps the URL it has, so the photo currently up on the projector
 *             is not swapped for an identical one and re-downloaded. Only
 *             genuinely new shots are taken from the response.
 *
 * Without that split, a slideshow polling for new material would visibly blink
 * every time it polled.
 */
type LoadMode = "merge" | "replace"

export function useEventMedia(
  hostToken: string,
  options: { pollMs?: number } = {},
): MediaState {
  const { pollMs } = options
  const [state, setState] = useState<MediaState>({ status: "loading" })

  const load = useCallback(
    async (mode: LoadMode): Promise<number | null> => {
      try {
        const response = await fetch(`/api/host/${hostToken}/gallery`, {
          cache: "no-store",
        })

        if (response.status === 403) {
          // The event is real and this is its host — it simply is not open yet.
          setState({ status: "locked" })
          return null
        }
        if (response.status === 404) {
          setState({ status: "gone" })
          return null
        }
        if (!response.ok) {
          setState({ status: "error", message: "Could not load your photos." })
          return null
        }

        const payload = (await response.json()) as {
          eventName: string
          items: HostMediaItem[]
          expiresInSeconds: number
        }

        setState((previous) => {
          if (mode === "replace" || previous.status !== "ready") {
            return {
              status: "ready",
              eventName: payload.eventName,
              items: payload.items,
            }
          }
          const known = new Map(previous.items.map((item) => [item.id, item]))
          return {
            status: "ready",
            eventName: payload.eventName,
            // Reusing the old object, not just the old URL: React sees the same
            // reference and leaves that tile's <img> completely alone.
            items: payload.items.map((item) => known.get(item.id) ?? item),
          }
        })
        return payload.expiresInSeconds
      } catch {
        setState({ status: "error", message: "Network error." })
        return null
      }
    },
    [hostToken],
  )

  useEffect(() => {
    let cancelled = false
    let expiryTimer: ReturnType<typeof setTimeout> | undefined
    let pollTimer: ReturnType<typeof setInterval> | undefined

    async function refresh(mode: LoadMode) {
      const expiresIn = await load(mode)
      if (cancelled || expiresIn === null || mode !== "replace") return

      // Re-arm from what the server said this time, not from a constant here.
      // If the TTL ever changes server-side, this follows it without a second
      // edit in a file nobody would think to look at.
      const delay = Math.max(30, expiresIn - REFRESH_MARGIN_SECONDS) * 1000
      expiryTimer = setTimeout(() => void refresh("replace"), delay)
    }

    void refresh("replace")
    if (pollMs) pollTimer = setInterval(() => void refresh("merge"), pollMs)

    return () => {
      cancelled = true
      if (expiryTimer) clearTimeout(expiryTimer)
      if (pollTimer) clearInterval(pollTimer)
    }
  }, [load, pollMs])

  return state
}
