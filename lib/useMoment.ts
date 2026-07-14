"use client"

import { useSyncExternalStore } from "react"

import { formatMoment } from "./format"

/**
 * A timestamp the reader can actually read, without tearing the page apart.
 *
 * formatMoment() deliberately renders in the reader's own timezone and locale.
 * The server has neither: on Vercel it runs in UTC, in whatever locale the Node
 * process happens to carry. So a client component that formats a date during
 * SSR emits one string and produces a different one a moment later in the
 * browser, and React does not shrug at that — it throws out the whole subtree
 * and rebuilds it:
 *
 *     Hydration failed because the server rendered text didn't match the client
 *     +  13.08.2026, 21:43        (browser, Europe/Zurich, de-CH)
 *     -  Aug 13, 2026, 7:43 PM    (server, UTC, en-US)
 *
 * That is measured, not theorised — a dev server started with TZ=UTC reproduces
 * it on the host dashboard every time. It never shows up locally, because the
 * dev server and the browser share a timezone, and that is exactly what makes
 * it worth a helper rather than a note somebody reads too late.
 *
 * suppressHydrationWarning is the wrong tool here, despite being React's
 * documented answer for timestamps. It silences the warning by keeping the
 * server's DOM while React's fiber records the client's value — the two are
 * then out of step with nothing left to reconcile them, and the host goes on
 * reading UTC until the underlying date itself changes. It hides the mismatch
 * by making it permanent.
 *
 * So: two passes. The hydration pass renders exactly what the server sent (no
 * date), which matches, and the render immediately after fills in the real one.
 * useSyncExternalStore is how you ask "am I hydrated yet" without setting state
 * from an effect; the store never changes, so this subscribes to nothing and
 * re-renders exactly once.
 */

const subscribe = () => () => {}
const getSnapshot = () => true
const getServerSnapshot = () => false

export function useHydrated(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}

/**
 * Null while the moment cannot be named — either there is no date, or the
 * browser has not taken over yet.
 *
 * Callers keep their own condition on the raw ISO value rather than on this
 * result, so the sentence they build keeps its shape across both passes and
 * only the date itself appears. Branching on this instead would swap one
 * sentence for another under the reader.
 */
export function useMoment(iso: string | null | undefined): string | null {
  const hydrated = useHydrated()
  if (!hydrated || !iso) return null
  return formatMoment(iso)
}
