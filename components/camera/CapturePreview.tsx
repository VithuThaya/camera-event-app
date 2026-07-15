"use client"

import { useEffect, useMemo } from "react"

import { Button } from "@/components/ui/Button"

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
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Pure black here, not the room's warm near-black — deliberately against
          the palette. object-contain letterboxes the shot, and a warm surround
          shifts how the eye reads the skin tones inside it. The frame around a
          photograph is the one place neutrality beats house style.

          min-h-0 for the same reason as the viewfinder: the shot inside carries
          its own size, and without this it would push Keep off the screen at the
          exact moment the guest is deciding whether to spend a slot. */}
      <div className="relative min-h-0 flex-1 overflow-hidden rounded-lg bg-black">
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

      {/* Keep is twice the width of Retake and the only lit thing on screen.
          Both are honest about the decision: keeping is what the guest came to
          do, and it is the one that spends something. */}
      <div className="mt-4 flex gap-3">
        <Button variant="quiet" onClick={onDiscard} disabled={disabled} className="flex-1">
          Retake
        </Button>
        <Button onClick={onKeep} disabled={disabled} className="flex-[2]">
          Keep this shot
        </Button>
      </div>
      <p className="mt-3 text-center text-xs text-ink-faint">
        Retaking costs you nothing. Keeping it uses one of your shots.
      </p>
    </div>
  )
}
