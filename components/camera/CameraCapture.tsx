"use client"

import { useCallback, useEffect, useRef, useState } from "react"

import { CapturePreview } from "./CapturePreview"
import { UploadProgress } from "./UploadProgress"
import {
  type Capture,
  UploadNetworkError,
  UploadRejectedError,
  uploadCapture,
} from "./uploadCapture"

/**
 * The camera.
 *
 * Shoot → look once → keep or retake. There is no gallery and no going back:
 * a kept shot disappears into the host's locked roll, which is the whole
 * premise. The scarcity is enforced server-side; the counter here is a mirror
 * so the guest can see it, never the thing that decides.
 */

const MAX_VIDEO_SECONDS = 15

/**
 * Ordered by preference. Safari supports only mp4 and Chrome/Firefox record
 * webm, so a fixed choice would break capture outright on roughly half the
 * phones at a party. isTypeSupported is the only honest way to ask.
 */
const VIDEO_MIME_CANDIDATES = [
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm",
  "video/mp4",
]

function pickVideoMimeType(): string | null {
  if (typeof MediaRecorder === "undefined") return null
  return VIDEO_MIME_CANDIDATES.find((type) => MediaRecorder.isTypeSupported(type)) ?? null
}

type Mode = "photo" | "video"

export function CameraCapture({
  guestToken,
  maxUploadsPerGuest,
  initialUploadCount,
}: {
  guestToken: string
  maxUploadsPerGuest: number
  initialUploadCount: number
}) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const hardStopRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const audioTrackRef = useRef<MediaStreamTrack | null>(null)
  const startedAtRef = useRef<number>(0)

  const [cameraError, setCameraError] = useState<string | null>(null)
  const [mode, setMode] = useState<Mode>("photo")
  const [facingMode, setFacingMode] = useState<"environment" | "user">("environment")
  const [recording, setRecording] = useState(false)
  const [secondsLeft, setSecondsLeft] = useState(MAX_VIDEO_SECONDS)
  const [capture, setCapture] = useState<Capture | null>(null)
  const [uploading, setUploading] = useState(false)
  const [progress, setProgress] = useState(0)
  const [uploadsUsed, setUploadsUsed] = useState(initialUploadCount)
  const [uploadError, setUploadError] = useState<string | null>(null)

  const remaining = Math.max(0, maxUploadsPerGuest - uploadsUsed)
  const outOfShots = remaining === 0

  // --- Live preview ---------------------------------------------------------
  useEffect(() => {
    let cancelled = false

    async function start() {
      try {
        // Video only. Holding the microphone open for a guest who is only
        // taking photos lights up the recording indicator on their phone and
        // is not something we asked for — audio is acquired per clip instead.
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode,
            // Hints, not guarantees. This is what keeps a clip near ~5 MB
            // instead of needing a compression pass we cannot afford on a
            // phone. Phase 4 re-checks it against real devices.
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
          audio: false,
        })
        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop())
          return
        }
        streamRef.current = stream
        if (videoRef.current) videoRef.current.srcObject = stream
        setCameraError(null)
      } catch (error) {
        if (cancelled) return
        const name = error instanceof DOMException ? error.name : ""
        setCameraError(
          name === "NotAllowedError"
            ? "Camera access was blocked. Allow it in your browser settings, then reload."
            : name === "NotFoundError"
              ? "No camera found on this device."
              : "Could not open the camera.",
        )
      }
    }

    void start()
    return () => {
      cancelled = true
      // Releasing the camera on unmount is not optional: leave it running and
      // the indicator stays lit and the next getUserMedia can fail outright.
      streamRef.current?.getTracks().forEach((track) => track.stop())
      streamRef.current = null
    }
  }, [facingMode])

  // --- Countdown ------------------------------------------------------------
  useEffect(() => {
    if (!recording) return
    const interval = setInterval(() => {
      const elapsed = (Date.now() - startedAtRef.current) / 1000
      setSecondsLeft(Math.max(0, Math.ceil(MAX_VIDEO_SECONDS - elapsed)))
    }, 200)
    return () => clearInterval(interval)
  }, [recording])

  const cleanUpRecording = useCallback(() => {
    if (hardStopRef.current) {
      clearTimeout(hardStopRef.current)
      hardStopRef.current = null
    }
    // Give the microphone straight back. It was only ever borrowed for the
    // length of the clip.
    audioTrackRef.current?.stop()
    audioTrackRef.current = null
    recorderRef.current = null
    chunksRef.current = []
    setRecording(false)
    setSecondsLeft(MAX_VIDEO_SECONDS)
  }, [])

  useEffect(() => cleanUpRecording, [cleanUpRecording])

  // --- Photo ----------------------------------------------------------------
  function takePhoto() {
    const video = videoRef.current
    if (!video || !video.videoWidth) return

    const canvas = document.createElement("canvas")
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    const context = canvas.getContext("2d")
    if (!context) return

    // The preview is mirrored for the front camera because that is what people
    // expect of a mirror. The photo is not — a mirrored photo has back-to-front
    // text in it, which is not what they saw and not what they meant to shoot.
    context.drawImage(video, 0, 0)

    canvas.toBlob(
      (blob) => {
        if (!blob) {
          setUploadError("Could not read the frame from the camera.")
          return
        }
        setUploadError(null)
        setCapture({ blob, mediaType: "photo", mimeType: "image/jpeg" })
      },
      "image/jpeg",
      0.85,
    )
  }

  // --- Video ----------------------------------------------------------------
  async function startRecording() {
    const stream = streamRef.current
    if (!stream) return

    const mimeType = pickVideoMimeType()
    if (!mimeType) {
      setUploadError("This browser cannot record video. Try a photo instead.")
      return
    }

    const tracks: MediaStreamTrack[] = [...stream.getVideoTracks()]
    try {
      const audio = await navigator.mediaDevices.getUserMedia({ audio: true })
      const track = audio.getAudioTracks()[0]
      if (track) {
        audioTrackRef.current = track
        tracks.push(track)
      }
    } catch {
      // A clip with no sound beats no clip. The guest declined the mic or the
      // device has none; neither is a reason to refuse the shot.
    }

    let recorder: MediaRecorder
    try {
      recorder = new MediaRecorder(new MediaStream(tracks), {
        mimeType,
        videoBitsPerSecond: 2_500_000,
      })
    } catch {
      audioTrackRef.current?.stop()
      audioTrackRef.current = null
      setUploadError("This browser cannot record video. Try a photo instead.")
      return
    }

    chunksRef.current = []
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunksRef.current.push(event.data)
    }
    recorder.onstop = () => {
      const durationSeconds = Math.min(
        MAX_VIDEO_SECONDS,
        (Date.now() - startedAtRef.current) / 1000,
      )
      const blob = new Blob(chunksRef.current, { type: mimeType })
      cleanUpRecording()
      if (blob.size === 0) {
        setUploadError("The recording came out empty. Try again.")
        return
      }
      setUploadError(null)
      setCapture({ blob, mediaType: "video", mimeType, durationSeconds })
    }

    recorderRef.current = recorder
    startedAtRef.current = Date.now()
    setUploadError(null)
    setSecondsLeft(MAX_VIDEO_SECONDS)
    setRecording(true)
    recorder.start()

    // The cap is enforced here, by stopping the recorder — not by a countdown
    // the guest is trusted to obey. A UI timer alone would let a backgrounded
    // tab or an ignored label produce a five-minute clip.
    hardStopRef.current = setTimeout(() => {
      if (recorderRef.current?.state === "recording") recorderRef.current.stop()
    }, MAX_VIDEO_SECONDS * 1000)
  }

  function stopRecording() {
    if (recorderRef.current?.state === "recording") recorderRef.current.stop()
  }

  // --- Keep -----------------------------------------------------------------
  async function keep() {
    if (!capture) return
    setUploading(true)
    setProgress(0)
    setUploadError(null)

    try {
      await uploadCapture(guestToken, capture, setProgress)
      setUploadsUsed((count) => count + 1)
      setCapture(null)
    } catch (error) {
      if (error instanceof UploadRejectedError) {
        setUploadError(error.message)
        // The server is the authority on the count. If it says the quota is
        // spent, believe it over our mirror — the guest may have shot from a
        // second tab, or the host may have lowered the limit mid-event.
        if (error.code === "upload_quota_exceeded") setUploadsUsed(maxUploadsPerGuest)
      } else if (error instanceof UploadNetworkError) {
        // Phase 4 queues this instead. Until then the shot is still in memory
        // and Keep can simply be tapped again, so say that rather than
        // pretending it is saved.
        setUploadError("No connection. Your shot is still here — try again.")
      } else {
        setUploadError("Something went wrong. Try again.")
      }
    } finally {
      setUploading(false)
      setProgress(0)
    }
  }

  // --- Render ---------------------------------------------------------------
  if (cameraError) {
    return (
      <div className="rounded border border-red-900 bg-red-950 px-4 py-3 text-sm text-red-300">
        {cameraError}
      </div>
    )
  }

  if (outOfShots && !capture) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center text-center">
        <p className="text-lg font-medium">That was your last shot.</p>
        <p className="mt-2 max-w-xs text-sm text-neutral-400">
          All {maxUploadsPerGuest} are in. The host has them — you will see the
          result when they reveal it.
        </p>
      </div>
    )
  }

  if (capture) {
    return (
      <div className="flex flex-1 flex-col">
        <CapturePreview
          capture={capture}
          onKeep={keep}
          onDiscard={() => {
            setCapture(null)
            setUploadError(null)
          }}
          disabled={uploading}
        />
        {uploading && (
          <div className="mt-4">
            <UploadProgress fraction={progress} />
          </div>
        )}
        {uploadError && (
          <p className="mt-3 rounded border border-red-900 bg-red-950 px-3 py-2 text-center text-sm text-red-300">
            {uploadError}
          </p>
        )}
      </div>
    )
  }

  return (
    <div className="flex flex-1 flex-col">
      <div className="relative flex-1 overflow-hidden rounded-lg bg-black">
        <video
          ref={videoRef}
          // playsInline keeps iOS from hijacking the stream into a fullscreen
          // player; muted is what allows autoplay at all.
          playsInline
          muted
          autoPlay
          className="h-full w-full object-cover"
          style={facingMode === "user" ? { transform: "scaleX(-1)" } : undefined}
        />

        {recording && (
          <div className="absolute left-1/2 top-4 flex -translate-x-1/2 items-center gap-2 rounded-full bg-black/70 px-3 py-1.5">
            <span className="h-2 w-2 animate-pulse rounded-full bg-red-500" />
            <span className="text-sm tabular-nums text-white">{secondsLeft}s</span>
          </div>
        )}

        <button
          type="button"
          onClick={() => setFacingMode((f) => (f === "environment" ? "user" : "environment"))}
          disabled={recording}
          className="absolute right-3 top-3 rounded-full bg-black/60 px-3 py-1.5 text-xs text-white disabled:opacity-40"
        >
          Flip
        </button>
      </div>

      <div className="mt-4 flex justify-center gap-1 rounded-full border border-neutral-800 p-1">
        {(["photo", "video"] as const).map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => setMode(option)}
            disabled={recording}
            className={`flex-1 rounded-full px-4 py-2 text-sm capitalize disabled:opacity-40 ${
              mode === option ? "bg-white text-black" : "text-neutral-400"
            }`}
          >
            {option}
          </button>
        ))}
      </div>

      {uploadError && (
        <p className="mt-3 rounded border border-red-900 bg-red-950 px-3 py-2 text-center text-sm text-red-300">
          {uploadError}
        </p>
      )}

      <div className="mt-4 flex flex-col items-center">
        {mode === "photo" ? (
          <button
            type="button"
            onClick={takePhoto}
            aria-label="Take photo"
            className="rounded-full border-4 border-white/80 bg-white active:scale-95"
            style={{ height: "4.5rem", width: "4.5rem" }}
          />
        ) : (
          <button
            type="button"
            onClick={recording ? stopRecording : startRecording}
            aria-label={recording ? "Stop recording" : "Start recording"}
            className="flex items-center justify-center rounded-full border-4 border-white/80 active:scale-95"
            style={{ height: "4.5rem", width: "4.5rem" }}
          >
            <span
              className={
                recording ? "h-6 w-6 rounded-sm bg-red-500" : "h-14 w-14 rounded-full bg-red-500"
              }
            />
          </button>
        )}
        <p className="mt-3 text-xs text-neutral-500">
          {remaining} of {maxUploadsPerGuest} shots left
          {mode === "video" && ` · up to ${MAX_VIDEO_SECONDS}s`}
        </p>
      </div>
    </div>
  )
}
