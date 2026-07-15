"use client"

import Link from "next/link"
import { useCallback, useState } from "react"

import { Alert } from "@/components/ui/Alert"
import { buttonStyles } from "@/components/ui/Button"
import { Panel } from "@/components/ui/Panel"

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
    return <p className="text-sm text-ink-faint">Loading your photos…</p>
  }

  if (state.status === "locked") {
    return (
      <Panel className="text-center">
        <p className="font-medium text-ink">Still sealed</p>
        <p className="mt-1 text-sm text-ink-dim">
          Nobody has seen these yet — not even you. Unlock the event to look.
        </p>
        <Link href={`/host/${hostToken}`} className={`${buttonStyles("quiet")} mt-4`}>
          Back to the dashboard
        </Link>
      </Panel>
    )
  }

  if (state.status === "gone") {
    return <p className="text-sm text-ink-faint">This event no longer exists.</p>
  }

  if (state.status === "error") {
    return <Alert>{state.message}</Alert>
  }

  if (state.items.length === 0) {
    return (
      <Panel className="text-center">
        <p className="font-medium text-ink">Nothing here yet</p>
        <p className="mt-1 text-sm text-ink-dim">
          The roll is open, but nobody has taken a shot. Share the guest link.
        </p>
      </Panel>
    )
  }

  return (
    <>
      {/* The actions live here rather than in the page header, and that is the
          whole point: this component is handed the gallery route's verdict and
          the page deliberately is not. A header that renders "Download all"
          without knowing whether the roll is sealed offers the host a lit button
          that answers 403 with a raw JSON body — which is exactly what it did.
          Putting them here leaves the unlock rule in its one home. */}
      <div className="mb-4 flex justify-end gap-2">
        <Link href={`/host/${hostToken}/slideshow`} className={buttonStyles("quiet")}>
          Slideshow
        </Link>
        {/* A plain link, not a fetch: the ZIP is streamed and can run to
            gigabytes, so it belongs to the browser's download manager rather
            than to a blob a tab would have to hold in memory first. */}
        <a href={`/api/host/${hostToken}/download-all`} className={buttonStyles()}>
          Download all
        </a>
      </div>

      {/* A contact sheet: square, dense, gap-1. The photographs sit next to each
          other with almost nothing between them, because on this screen they are
          the only thing worth looking at — no captions, no cards, no shadows. */}
      <div className="grid grid-cols-2 gap-1 sm:grid-cols-3 lg:grid-cols-4">
        {state.items.map((item, index) => (
          <button
            key={item.id}
            type="button"
            onClick={() => setOpenIndex(index)}
            className="group relative aspect-square overflow-hidden bg-surface"
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
                <span className="numeric absolute bottom-1 right-1 rounded bg-black/70 px-1.5 py-0.5 text-[10px] text-white">
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
