"use client"

import { useEffect, useMemo, useRef, useState } from "react"

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
  poster,
  previewUrl,
  preparing,
  onKeep,
  onDiscard,
  disabled,
}: {
  capture: Capture
  poster?: string | null
  // A signed HTTPS URL for the same clip, uploaded in the background. iOS plays
  // this where it refuses the local blob; null until the upload lands.
  previewUrl?: string | null
  // The background upload is still in flight — show the still, but say it is
  // coming rather than implying playback failed.
  preparing?: boolean
  onKeep: () => void
  onDiscard: () => void
  disabled?: boolean
}) {
  const url = useMemo(() => URL.createObjectURL(capture.blob), [capture.blob])
  const videoRef = useRef<HTMLVideoElement>(null)
  // iOS will not play a freshly recorded clip from a blob: URL — it reports the
  // source as unsupported (MediaError 4) and never loads a frame, even though
  // the identical bytes play once served over HTTPS. So on the blob element's
  // error we switch to the HTTPS `previewUrl` once it has uploaded, and to the
  // still frame (`poster`) until then. Other browsers play the blob straight
  // away and never trip this. Tracking WHICH url failed (not a bare boolean)
  // resets the fallback for free when the next clip mounts a new url.
  const [failedUrl, setFailedUrl] = useState<string | null>(null)
  const playbackFailed = failedUrl === url

  // Blob URLs pin the whole blob in memory until revoked. With a handful of
  // 40 MB clips per guest, leaking these is enough to get the tab killed on a
  // mid-range phone.
  useEffect(() => () => URL.revokeObjectURL(url), [url])

  // MediaRecorder writes clips with no duration in the header (video.duration
  // reads Infinity), and a browser that can play the blob at all still needs the
  // duration before it will start. Force a measure — seek far past the end, which
  // makes the engine scan to the real end and mark the clip seekable — then reset
  // and play. `timeupdate` (not the unreliable `seeked`) signals the scan landed.
  // `muted` is a property so the only autoplay iOS allows, muted and inline, is
  // honoured. On iOS this still ends at the error handler below; elsewhere it
  // plays.
  useEffect(() => {
    if (capture.mediaType !== "video") return
    const video = videoRef.current
    if (!video) return
    video.muted = true

    const play = () => {
      video.play().catch(() => {
        // Refused even muted — the controls are there to start it by hand.
      })
    }

    const onMeta = () => {
      if (video.duration === Infinity || Number.isNaN(video.duration)) {
        const onScan = () => {
          video.removeEventListener("timeupdate", onScan)
          video.currentTime = 0
          play()
        }
        video.addEventListener("timeupdate", onScan)
        // Any time past a 15 s clip; the engine scans to the real end to satisfy it.
        video.currentTime = 1e7
      } else {
        play()
      }
    }

    if (video.readyState >= 1) onMeta()
    video.addEventListener("loadedmetadata", onMeta)
    return () => video.removeEventListener("loadedmetadata", onMeta)
  }, [url, capture.mediaType])

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
        {/* Video review, three ways. Most browsers play the recorded blob
            straight away. iOS refuses the blob (MediaError 4), so on its error we
            fall back: to the same clip served over HTTPS once the background
            upload lands, and to the still frame until then. */}
        {capture.mediaType === "video" && !playbackFailed && (
          // The ref callback sets muted synchronously, the instant the node
          // exists — so the autoPlay below sees a muted element (unmuted autoplay
          // is blocked). preload="auto" fetches the blob rather than waiting;
          // onError hands off to the HTTPS clip or the still when iOS refuses it.
          <video
            ref={(element) => {
              videoRef.current = element
              if (element) element.muted = true
            }}
            src={url}
            poster={poster ?? undefined}
            className="h-full w-full object-contain"
            controls
            playsInline
            loop
            muted
            autoPlay
            preload="auto"
            onError={() => setFailedUrl(url)}
          />
        )}
        {capture.mediaType === "video" && playbackFailed && previewUrl && (
          // The clip served over HTTPS — the one form iOS will play. A fresh
          // element keyed on the URL, muted set synchronously so its autoplay is
          // allowed too. No blob seek-trick needed: a served file has a duration.
          <video
            key={previewUrl}
            ref={(element) => {
              if (element) element.muted = true
            }}
            src={previewUrl}
            poster={poster ?? undefined}
            className="h-full w-full object-contain"
            controls
            playsInline
            loop
            muted
            autoPlay
            preload="auto"
          />
        )}
        {capture.mediaType === "video" && playbackFailed && !previewUrl && poster && (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={poster} alt="Your clip, before you keep it" className="h-full w-full object-contain" />
            <p className="absolute inset-x-0 bottom-0 bg-black/60 px-3 py-1.5 text-center text-[11px] text-ink-dim">
              {preparing
                ? "Preparing your video…"
                : "Preview only — your video is fine and plays once it is kept."}
            </p>
          </>
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
