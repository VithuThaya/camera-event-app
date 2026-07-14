"use client"

import Link from "next/link"
import { useCallback, useState } from "react"

import { MediaLightbox } from "./MediaLightbox"
import { useEventMedia } from "./useEventMedia"

/**
 * The roll, as a grid.
 *
 * Full-size images in every tile — deliberately, and reluctantly. Phase 2
 * stores exactly one rendition of each shot, so there is no thumbnail to serve.
 * Across a few hundred photos that is a real amount of bandwidth, and it is the
 * honest cost of not having built a thumbnailing step rather than something to
 * paper over. Lazy loading holds it to what is actually on screen.
 */
export function GalleryGrid({ hostToken }: { hostToken: string }) {
  const state = useEventMedia(hostToken)
  const [openIndex, setOpenIndex] = useState<number | null>(null)

  const count = state.status === "ready" ? state.items.length : 0

  const step = useCallback(
    (delta: number) => {
      setOpenIndex((current) => {
        if (current === null || count === 0) return current
        // Wrap rather than dead-end. At the last photo, a "next" that goes
        // nowhere reads as a broken button.
        return (current + delta + count) % count
      })
    },
    [count],
  )

  if (state.status === "loading") {
    return <p className="text-sm text-neutral-500">Loading your photos…</p>
  }

  if (state.status === "locked") {
    return (
      <div className="rounded border border-neutral-800 p-6 text-center">
        <p className="font-medium">Still sealed</p>
        <p className="mt-1 text-sm text-neutral-400">
          Nobody has seen these yet — not even you. Unlock the event to look.
        </p>
        <Link
          href={`/host/${hostToken}`}
          className="mt-4 inline-block rounded bg-white px-4 py-2 text-sm font-medium text-black"
        >
          Back to the dashboard
        </Link>
      </div>
    )
  }

  if (state.status === "gone") {
    return <p className="text-sm text-neutral-500">This event no longer exists.</p>
  }

  if (state.status === "error") {
    return <p className="text-sm text-red-400">{state.message}</p>
  }

  if (state.items.length === 0) {
    return (
      <div className="rounded border border-neutral-800 p-6 text-center">
        <p className="font-medium">Nothing here yet</p>
        <p className="mt-1 text-sm text-neutral-400">
          The roll is open, but nobody has taken a shot. Share the guest link.
        </p>
      </div>
    )
  }

  return (
    <>
      <div className="grid grid-cols-2 gap-1 sm:grid-cols-3 lg:grid-cols-4">
        {state.items.map((item, index) => (
          <button
            key={item.id}
            type="button"
            onClick={() => setOpenIndex(index)}
            className="relative aspect-square overflow-hidden bg-neutral-900"
          >
            {item.mediaType === "video" ? (
              <>
                {/* preload="metadata" pulls enough for a first frame and stops.
                    Fetching whole clips to draw a grid would download the entire
                    event just to render it. */}
                <video
                  src={item.url}
                  className="h-full w-full object-cover"
                  preload="metadata"
                  muted
                  playsInline
                />
                <span className="absolute bottom-1 right-1 rounded bg-black/70 px-1.5 py-0.5 text-[10px] text-white">
                  {item.durationSeconds ? `${Math.round(item.durationSeconds)}s` : "video"}
                </span>
              </>
            ) : (
              /* eslint-disable-next-line @next/next/no-img-element -- signed, short-lived URL on another origin: next/image cannot fetch it, and must not cache it */
              <img
                src={item.url}
                alt=""
                loading="lazy"
                className="h-full w-full object-cover"
              />
            )}
          </button>
        ))}
      </div>

      {openIndex !== null && (
        <MediaLightbox
          items={state.items}
          index={openIndex}
          onClose={() => setOpenIndex(null)}
          onStep={step}
        />
      )}
    </>
  )
}
