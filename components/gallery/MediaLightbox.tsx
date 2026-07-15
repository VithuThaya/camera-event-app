"use client"

import { useEffect } from "react"

import type { HostMediaItem } from "@/lib/host"

/**
 * One shot, full size, over the grid.
 *
 * Keyboard-driven as much as tap-driven: the host reviewing a wedding's roll is
 * at a laptop, and arrowing through a few hundred photos beats aiming at a
 * chevron a few hundred times.
 */
export function MediaLightbox({
  items,
  index,
  onClose,
  onStep,
}: {
  items: HostMediaItem[]
  index: number
  onClose: () => void
  onStep: (delta: number) => void
}) {
  useEffect(() => {
    function handleKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose()
      if (event.key === "ArrowRight") onStep(1)
      if (event.key === "ArrowLeft") onStep(-1)
    }
    window.addEventListener("keydown", handleKey)
    return () => window.removeEventListener("keydown", handleKey)
  }, [onClose, onStep])

  const item = items[index]
  if (!item) return null

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black/95">
      {/* White at 50%, not a room token: this chrome floats over whatever the
          photograph happens to be, so it cannot borrow the darkroom's contrast
          the way the rest of the interface can. */}
      <div className="flex items-center justify-between px-4 py-3 text-sm text-white/50">
        <span className="numeric">
          {index + 1} / {items.length}
        </span>
        <div className="flex items-center gap-4">
          <a
            href={item.url}
            download
            className="underline underline-offset-4 transition-colors hover:text-white"
          >
            Download
          </a>
          <button type="button" onClick={onClose} className="transition-colors hover:text-white">
            Close
          </button>
        </div>
      </div>

      <div className="relative flex flex-1 items-center justify-center overflow-hidden px-4 pb-4">
        {item.mediaType === "video" ? (
          // key forces a fresh element per item. Without it React reuses the
          // <video> and the previous clip keeps playing under the new source.
          <video
            key={item.id}
            src={item.url}
            className="max-h-full max-w-full"
            controls
            autoPlay
            playsInline
          />
        ) : (
          /* eslint-disable-next-line @next/next/no-img-element -- signed, short-lived URL on another origin: the optimizer cannot fetch it, and would only cache what must not be cached */
          <img
            key={item.id}
            src={item.url}
            alt=""
            className="max-h-full max-w-full object-contain"
          />
        )}

        <StepButton side="left" onClick={() => onStep(-1)} />
        <StepButton side="right" onClick={() => onStep(1)} />
      </div>
    </div>
  )
}

function StepButton({ side, onClick }: { side: "left" | "right"; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={side === "left" ? "Previous" : "Next"}
      className={`absolute inset-y-0 ${side === "left" ? "left-0" : "right-0"} w-1/4 opacity-0 transition-opacity hover:opacity-100`}
    >
      <span
        className={`absolute top-1/2 ${side === "left" ? "left-4" : "right-4"} -translate-y-1/2 rounded-full bg-black/60 px-3 py-2 text-white`}
      >
        {side === "left" ? "‹" : "›"}
      </span>
    </button>
  )
}
