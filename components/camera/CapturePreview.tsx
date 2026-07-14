"use client"

import { useEffect, useMemo } from "react"

import type { Capture } from "./uploadCapture"

/**
 * The one look the guest gets at their own shot.
 *
 * Entirely local — this renders the blob straight out of memory, nothing has
 * touched the network yet. That is the product working as designed: the guest
 * decides whether the shot is worth one of their few slots, and once they keep
 * it, they will not see it again. The host's roll is the only place it lives.
 */
export function CapturePreview({
  capture,
  onKeep,
  onDiscard,
  disabled,
}: {
  capture: Capture
  onKeep: () => void
  onDiscard: () => void
  disabled?: boolean
}) {
  const url = useMemo(() => URL.createObjectURL(capture.blob), [capture.blob])

  // Blob URLs pin the whole blob in memory until revoked. With a handful of
  // 40 MB clips per guest, leaking these is enough to get the tab killed on a
  // mid-range phone.
  useEffect(() => () => URL.revokeObjectURL(url), [url])

  return (
    <div className="flex flex-1 flex-col">
      <div className="relative flex-1 overflow-hidden rounded-lg bg-black">
        {/* A blob: URL cannot go through next/image, and there is nothing to
            optimise: these bytes are already in memory and never hit the
            network. */}
        {capture.mediaType === "photo" && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={url} alt="Your shot, before you keep it" className="h-full w-full object-contain" />
        )}
        {capture.mediaType === "video" && (
          <video src={url} className="h-full w-full object-contain" controls playsInline autoPlay loop />
        )}
      </div>

      <div className="mt-4 flex gap-3">
        <button
          type="button"
          onClick={onDiscard}
          disabled={disabled}
          className="flex-1 rounded border border-neutral-700 px-4 py-3 text-sm font-medium text-neutral-300 disabled:opacity-40"
        >
          Retake
        </button>
        <button
          type="button"
          onClick={onKeep}
          disabled={disabled}
          className="flex-[2] rounded bg-white px-4 py-3 text-sm font-medium text-black disabled:opacity-40"
        >
          Keep this shot
        </button>
      </div>
      <p className="mt-3 text-center text-xs text-neutral-500">
        Retaking costs you nothing. Keeping it uses one of your shots.
      </p>
    </div>
  )
}
