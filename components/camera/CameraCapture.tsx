"use client"

import { useCallback, useEffect, useRef, useState } from "react"

import { Alert } from "@/components/ui/Alert"
import type { FlushOutcome } from "@/lib/offline/flush"
import { type UploadQueue, useUploadQueue } from "@/lib/offline/useUploadQueue"

import { CapturePreview } from "./CapturePreview"
import { UploadProgress } from "./UploadProgress"
import {
  type Capture,
  cancelPending,
  confirmUpload,
  fetchPreviewUrl,
  reserveAndPut,
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
 * Ordered by preference, mp4 first, and the order is the whole point.
 *
 * iOS is two-faced about webm: recent WebKit reports it can *record* webm
 * (isTypeSupported says yes, because the VP8/9 encoder is there for WebRTC) but
 * the <video> element cannot *play* webm at all. So a naive webm-first pick
 * records a clip that dies with "format not supported" the moment the guest
 * reviews it — and again in the host's slideshow — on every iPhone. mp4 is the
 * one container iOS agrees to on both ends, and every other browser can play it
 * too, so it is the safe default. webm stays only as a fallback for browsers
 * that cannot encode mp4 (older desktop Chrome/Firefox), which can always play
 * webm anyway. isTypeSupported is still the only honest way to ask each device.
 */
const VIDEO_MIME_CANDIDATES = [
  "video/mp4",
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm",
]

function pickVideoMimeType(): string | null {
  if (typeof MediaRecorder === "undefined") return null
  return VIDEO_MIME_CANDIDATES.find((type) => MediaRecorder.isTypeSupported(type)) ?? null
}

type Mode = "photo" | "video"

/**
 * The background upload behind the video review (see the videoUpload state).
 * "uploading" while the bytes go up, "ready" once they are playable over HTTPS,
 * "failed" when there was no signal or the reserve was refused — in which case
 * the review falls back to the still and Keep falls back to a full upload.
 */
type VideoUpload =
  | { status: "uploading" }
  | { status: "ready"; mediaId: string; previewUrl: string }
  | { status: "failed" }

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
  // How far the phone is turned from portrait, in 90° steps (0..3), read at the
  // instant of a shot so a sideways grip is saved upright. A ref, not state: it
  // changes as fast as the sensor fires and nothing renders from it.
  const orientationRef = useRef(0)
  const motionSeenRef = useRef(false)
  const motionPermRef = useRef(false)
  // The canvas a clip is recorded through, and its draw loop. Recording the raw
  // camera track would bake in the front-camera mirror and a sideways grip;
  // drawing each frame through a canvas is the one place to turn them upright.
  const recordCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const rafRef = useRef<number | null>(null)

  const [cameraError, setCameraError] = useState<string | null>(null)
  const [mode, setMode] = useState<Mode>("photo")
  const [facingMode, setFacingMode] = useState<"environment" | "user">("environment")
  const [recording, setRecording] = useState(false)
  const [secondsLeft, setSecondsLeft] = useState(MAX_VIDEO_SECONDS)
  const [capture, setCapture] = useState<Capture | null>(null)
  // A still of the last recorded frame, for the review screen only. iOS refuses
  // to play a freshly recorded clip from a blob: URL (the same bytes play fine
  // once served over HTTPS in the slideshow), so on the phone the guest reviews
  // this frame instead of a dead player. Never uploaded, never queued — a data:
  // URL that lives only as long as the preview.
  const [posterUrl, setPosterUrl] = useState<string | null>(null)
  // Upload-first review, videos only. iOS will not play a recorded clip from a
  // blob: URL, but it plays the same bytes fine over HTTPS — so a clip is
  // uploaded to its pending object the moment recording stops, and the review
  // plays it back from a signed URL. "ready" means the bytes are up and
  // playable: keeping then only has to confirm them, discarding deletes them.
  // Photos never touch this; they preview straight from the blob.
  const [videoUpload, setVideoUpload] = useState<VideoUpload | null>(null)
  // Bumped on every stop, keep, and discard. A background upload checks it when
  // it finishes: if it has moved on, the guest retook or kept in the meantime,
  // so the just-uploaded pending object is cancelled instead of shown.
  const uploadGenRef = useRef(0)
  // The in-flight background upload, so a Keep tapped before it finishes can
  // await it instead of racing it into a second upload.
  const videoUploadRef = useRef<Promise<VideoUpload> | null>(null)
  const [uploading, setUploading] = useState(false)
  const [progress, setProgress] = useState(0)
  const [uploadsUsed, setUploadsUsed] = useState(initialUploadCount)
  /**
   * The server has said no more, for reasons of its own.
   *
   * Kept apart from uploadsUsed, which counts shots that really went up. The
   * two are usually the same thing — you run out because you shot everything —
   * but not always: the host can lower the limit under a guest mid-event. Its
   * own flag, because the alternative is winding uploadsUsed up to the limit
   * as a signal, and then every sentence built from that number is a lie about
   * how many photos the host is holding.
   */
  const [quotaSpent, setQuotaSpent] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)

  const queue = useUploadQueue(
    guestToken,
    useCallback(
      (outcome: FlushOutcome) => {
        setUploadsUsed((used) => used + outcome.uploaded)
        // Believe the server over our arithmetic. Without this the refused
        // shot's slot is handed straight back and the guest is refused all
        // over again.
        if (outcome.rejected.some((error) => error.code === "upload_quota_exceeded")) {
          setQuotaSpent(true)
        }
      },
      [],
    ),
  )

  // A waiting shot is a spent shot. It is not up yet, but the guest took it and
  // meant to keep it, so offering the slot a second time would be offering
  // something we cannot deliver — the server will refuse it on the way out.
  const remaining = quotaSpent
    ? 0
    : Math.max(0, maxUploadsPerGuest - uploadsUsed - queue.queuedCount)
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

  // --- Orientation ----------------------------------------------------------
  // Which way is up, so a shot taken sideways can be turned upright. Two
  // signals: screen.orientation is exact but a phone with its rotation lock on
  // reports portrait forever and never sees a sideways grip; the motion sensor
  // reads gravity directly and does, at the cost of a permission prompt on iOS.
  // Once the sensor has spoken we trust it over the screen.
  useEffect(() => {
    function fromScreen() {
      if (motionSeenRef.current) return
      const angle = screen.orientation?.angle
      if (typeof angle === "number") orientationRef.current = (((angle / 90) % 4) + 4) % 4
    }
    function fromMotion(event: DeviceMotionEvent) {
      const g = event.accelerationIncludingGravity
      if (!g || g.x == null || g.y == null) return
      const ax = g.x
      const ay = g.y
      // A deadband so a phone held flat-ish does not flicker between guesses.
      if (Math.abs(ax) - Math.abs(ay) > 4) {
        // Landscape. Which shoulder the top of the phone fell toward — flip
        // these two if a re-test shows it spinning the wrong way.
        orientationRef.current = ax > 0 ? 3 : 1
      } else if (Math.abs(ay) - Math.abs(ax) > 4) {
        // Portrait. iOS reports gravity as ay < 0 when the phone is held
        // upright, so upright is 0 (no turn) and only a genuinely upside-down
        // phone is 2. The reverse saved every normal portrait shot upside down.
        orientationRef.current = ay > 0 ? 2 : 0
      }
      motionSeenRef.current = true
    }
    fromScreen()
    screen.orientation?.addEventListener("change", fromScreen)
    window.addEventListener("devicemotion", fromMotion)
    return () => {
      screen.orientation?.removeEventListener("change", fromScreen)
      window.removeEventListener("devicemotion", fromMotion)
    }
  }, [])

  // iOS hands out the motion sensor only after an explicit ask, and only from a
  // user gesture — so this rides on the first shutter or record tap. Denied, or
  // an older browser, and we fall back to screen.orientation on its own.
  async function ensureMotionPermission() {
    if (motionPermRef.current) return
    motionPermRef.current = true
    const MotionEvent = window.DeviceMotionEvent as unknown as {
      requestPermission?: () => Promise<string>
    }
    if (typeof MotionEvent?.requestPermission === "function") {
      try {
        await MotionEvent.requestPermission()
      } catch {
        // Denied. Nothing to do — the fallback is already in place.
      }
    }
  }

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
    // Stop drawing frames into the record canvas — the clip is done, and a loop
    // left running would spin for the rest of the guest's visit.
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
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
    void ensureMotionPermission()
    const video = videoRef.current
    if (!video || !video.videoWidth) return

    const frameWidth = video.videoWidth
    const frameHeight = video.videoHeight

    // Turned upright using whichever orientation signal we have (see the
    // orientation effect): a sideways grip is saved as portrait, not on its
    // side. 0 means portrait or unknown — nothing rotated, as before.
    const quarterTurns = orientationRef.current
    const sideways = quarterTurns === 1 || quarterTurns === 3

    const canvas = document.createElement("canvas")
    canvas.width = sideways ? frameHeight : frameWidth
    canvas.height = sideways ? frameWidth : frameHeight
    const context = canvas.getContext("2d")
    if (!context) return

    // Work from the centre so rotation and the front-camera mirror compose
    // without fighting each other. Order is deliberate and load-bearing: turn
    // the frame upright FIRST, then flip the front camera. Rotate-then-flip
    // makes the front and back cameras turn the same visible way; flip-then-
    // rotate silently negates the rotation for the front camera only, which is
    // why a sideways back-camera shot came out upside down while the front was
    // fine. The flip itself un-mirrors the front frame iOS hands us already
    // mirrored, so the kept photo does not have back-to-front text.
    context.translate(canvas.width / 2, canvas.height / 2)
    context.rotate(-(quarterTurns * Math.PI) / 2)
    if (facingMode === "user") context.scale(-1, 1)
    context.drawImage(video, -frameWidth / 2, -frameHeight / 2)

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

  // Push a just-recorded clip to its pending object in the background, so the
  // review can play it back over HTTPS (iOS refuses the local blob). Guarded by
  // the generation counter: if the guest retakes or keeps before this finishes,
  // the upload it produced is cancelled rather than shown.
  function startVideoUpload(cap: Capture): Promise<VideoUpload> {
    const gen = ++uploadGenRef.current
    setVideoUpload({ status: "uploading" })
    const run = async (): Promise<VideoUpload> => {
      try {
        const mediaId = await reserveAndPut(guestToken, cap)
        if (uploadGenRef.current !== gen) {
          void cancelPending(guestToken, mediaId)
          return { status: "failed" }
        }
        // One retry: a signed read URL cannot be minted until the PUT is visible
        // in the bucket, usually instant but not guaranteed the same tick.
        let previewUrl: string
        try {
          previewUrl = await fetchPreviewUrl(guestToken, mediaId)
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 400))
          previewUrl = await fetchPreviewUrl(guestToken, mediaId)
        }
        if (uploadGenRef.current !== gen) {
          void cancelPending(guestToken, mediaId)
          return { status: "failed" }
        }
        const ready: VideoUpload = { status: "ready", mediaId, previewUrl }
        setVideoUpload(ready)
        return ready
      } catch {
        // No signal, or the reserve was refused. The review shows the still, and
        // Keep falls back to a full upload-on-keep (quota gate + offline queue),
        // so there is nothing to surface here.
        if (uploadGenRef.current === gen) setVideoUpload({ status: "failed" })
        return { status: "failed" }
      }
    }
    const promise = run()
    videoUploadRef.current = promise
    return promise
  }

  // --- Video ----------------------------------------------------------------
  async function startRecording() {
    void ensureMotionPermission()
    const stream = streamRef.current
    const sourceVideo = videoRef.current
    if (!stream || !sourceVideo || !sourceVideo.videoWidth) return

    const mimeType = pickVideoMimeType()
    if (!mimeType) {
      setUploadError("This browser cannot record video. Try a photo instead.")
      return
    }

    // Record through a canvas, not the raw camera track — the only place the
    // front-camera mirror and a sideways grip can be turned right, the same
    // transform a photo gets, applied to every frame. Orientation is frozen at
    // the start: a clip that resized itself mid-record would not survive
    // MediaRecorder.
    const quarterTurns = orientationRef.current
    const sideways = quarterTurns === 1 || quarterTurns === 3
    const frameWidth = sourceVideo.videoWidth
    const frameHeight = sourceVideo.videoHeight
    const mirror = facingMode === "user"

    const canvas = recordCanvasRef.current ?? document.createElement("canvas")
    recordCanvasRef.current = canvas
    canvas.width = sideways ? frameHeight : frameWidth
    canvas.height = sideways ? frameWidth : frameHeight
    const context = canvas.getContext("2d")
    if (!context) {
      setUploadError("This browser cannot record video. Try a photo instead.")
      return
    }

    const drawFrame = () => {
      context.save()
      context.translate(canvas.width / 2, canvas.height / 2)
      // Same order as the photo: rotate first, then flip the front camera, so
      // both cameras turn the same visible way (see takePhoto for why).
      context.rotate(-(quarterTurns * Math.PI) / 2)
      if (mirror) context.scale(-1, 1)
      context.drawImage(sourceVideo, -frameWidth / 2, -frameHeight / 2)
      context.restore()
      rafRef.current = requestAnimationFrame(drawFrame)
    }
    drawFrame()

    // 30 fps is plenty for a party clip and half the frames to encode.
    const canvasStream = canvas.captureStream(30)
    const tracks: MediaStreamTrack[] = [...canvasStream.getVideoTracks()]
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
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
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
      // Grab the last drawn frame as the review still before cleanup — the
      // canvas keeps its pixels, and this is the one frame iOS will actually
      // show for a clip it will not play from a blob. Low quality on purpose:
      // it is a keep/retake thumbnail, not the kept media.
      const poster = recordCanvasRef.current?.toDataURL("image/jpeg", 0.7) ?? null
      cleanUpRecording()
      if (blob.size === 0) {
        setUploadError("The recording came out empty. Try again.")
        return
      }
      const videoCapture: Capture = { blob, mediaType: "video", mimeType, durationSeconds }
      setUploadError(null)
      setPosterUrl(poster)
      setCapture(videoCapture)
      // Start the upload now, while the guest is still deciding, so the review
      // can play the clip back over HTTPS instead of the blob iOS will not touch.
      void startVideoUpload(videoCapture)
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
      let handled = false
      if (capture.mediaType === "video" && videoUploadRef.current) {
        // Wait for the background upload if it is still running, so a Keep tapped
        // early confirms those bytes rather than racing a second upload beside
        // them. A failed upload (offline) falls through to the full upload below.
        const uploaded = await videoUploadRef.current
        if (uploaded.status === "ready") {
          setProgress(1)
          await confirmUpload(guestToken, uploaded.mediaId)
          handled = true
        }
      }
      if (!handled) {
        await uploadCapture(guestToken, capture, setProgress)
      }
      uploadGenRef.current++
      videoUploadRef.current = null
      setUploadsUsed((count) => count + 1)
      setCapture(null)
      setPosterUrl(null)
      setVideoUpload(null)
    } catch (error) {
      if (error instanceof UploadRejectedError) {
        setUploadError(error.message)
        // The server is the authority. If it says the quota is spent, believe
        // it over our mirror — the guest may have shot from a second tab, or
        // the host may have lowered the limit mid-event.
        if (error.code === "upload_quota_exceeded") setQuotaSpent(true)
      } else if (error instanceof UploadNetworkError) {
        const saved = await queue.queue(capture)
        if (saved) {
          // Nothing to apologise for and nothing for the guest to do. The shot
          // is on the phone, the counter already treats it as spent, and the
          // notice below the shutter says the rest. Back to the camera.
          uploadGenRef.current++
          videoUploadRef.current = null
          setCapture(null)
          setPosterUrl(null)
          setVideoUpload(null)
        } else {
          // The queue could not take it — no IndexedDB, or no room left on the
          // device. The shot is still in memory and Keep still works, so say
          // exactly that instead of pretending it is safe.
          setUploadError("No connection, and this phone cannot hold the shot. Try again.")
        }
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
    return <Alert>{cameraError}</Alert>
  }

  if (outOfShots && !capture) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center text-center">
        <p className="text-lg font-medium text-ink">That was your last shot.</p>
        <p className="mt-2 max-w-xs text-sm text-ink-dim">
          {/* Both halves are counted from what actually went up, never from
              the limit. "The host has them" is only true once they are up, and
              the number beside it is only true if it is the number we sent —
              a guest whose last shot was refused has not delivered twenty
              photos, however spent their allowance is. */}
          {queue.queuedCount > 0
            ? "The last of them are still on your phone, waiting for signal."
            : `All ${uploadsUsed} are in. The host has them — you will see the result when they reveal it.`}
        </p>
        <div className="mt-4 w-full max-w-xs">
          <QueuedShots queue={queue} />
        </div>
      </div>
    )
  }

  if (capture) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <CapturePreview
          capture={capture}
          poster={posterUrl}
          previewUrl={videoUpload?.status === "ready" ? videoUpload.previewUrl : null}
          preparing={videoUpload?.status === "uploading"}
          onKeep={keep}
          onDiscard={() => {
            // Invalidate any in-flight upload, and delete one that already landed
            // — a discarded clip must not keep charging the guest a slot.
            uploadGenRef.current++
            videoUploadRef.current = null
            if (capture.mediaType === "video" && videoUpload?.status === "ready") {
              void cancelPending(guestToken, videoUpload.mediaId)
            }
            setCapture(null)
            setPosterUrl(null)
            setVideoUpload(null)
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
          <Alert className="mt-3 text-center">{uploadError}</Alert>
        )}
        <QueuedShots queue={queue} />
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Pure black behind the viewfinder, not the room's warm near-black —
          deliberately against the palette. This is the surround a photograph is
          judged against, and a warm frame shifts how the eye reads the skin
          tones inside it. Neutrality beats house style here. */}
      {/* min-h-0 is load-bearing. A flex item refuses to shrink below its own
          content by default, and once the stream is live the <video> carries the
          camera's intrinsic portrait size — so without this the viewfinder wins
          the argument against the shutter and the guest has to scroll to shoot. */}
      <div className="relative min-h-0 flex-1 overflow-hidden rounded-xl bg-black ring-1 ring-edge">
        <video
          // Not a plain ref. Previewing a shot unmounts this element, so the
          // one that comes back afterwards is a different node with nothing
          // attached — and the effect that opened the camera only runs when
          // facingMode changes, so it never reattaches. The stream is still
          // running the whole time; it is simply pointed at a node that is no
          // longer in the document. Without this the camera dies after the
          // first shot and a guest with twenty shots gets one.
          ref={(element) => {
            videoRef.current = element
            if (element && streamRef.current) element.srcObject = streamRef.current
          }}
          // playsInline keeps iOS from hijacking the stream into a fullscreen
          // player; muted is what allows autoplay at all.
          playsInline
          muted
          autoPlay
          className="h-full w-full object-cover"
          style={facingMode === "user" ? { transform: "scaleX(-1)" } : undefined}
        />

        {/* The one place alarm-red is not an error: it is the universal "you
            are recording" and has to be readable at a glance in a dim room, on
            a moving phone, by someone who is not concentrating. */}
        {recording && (
          <div className="absolute left-1/2 top-4 flex -translate-x-1/2 items-center gap-2 rounded-full bg-black/70 px-3 py-1.5 backdrop-blur-sm">
            <span className="h-2 w-2 animate-pulse rounded-full bg-alarm" />
            <span className="numeric text-sm text-ink">{secondsLeft}s</span>
          </div>
        )}

        <button
          type="button"
          onClick={() => setFacingMode((f) => (f === "environment" ? "user" : "environment"))}
          disabled={recording}
          aria-label={facingMode === "environment" ? "Switch to front camera" : "Switch to back camera"}
          className="absolute right-3 top-3 rounded-full bg-black/50 px-3 py-2 text-xs text-ink backdrop-blur-sm disabled:opacity-40"
        >
          Flip
        </button>
      </div>

      {/* The selected mode is lit, the other is barely there. Two states, no
          border-box competing with the viewfinder above it. */}
      <div className="mt-4 flex justify-center gap-1 rounded-full border border-edge p-1">
        {(["photo", "video"] as const).map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => setMode(option)}
            disabled={recording}
            aria-pressed={mode === option}
            className={`flex-1 rounded-full px-4 py-2 text-sm capitalize transition-colors disabled:opacity-40 ${
              mode === option ? "bg-surface-lift text-ink" : "text-ink-faint"
            }`}
          >
            {option}
          </button>
        ))}
      </div>

      {uploadError && <Alert className="mt-3 text-center">{uploadError}</Alert>}

      {/* The shutter stays white, not safelight. It is the one control a guest
          has to find one-handed, drunk, in a dark room, without looking — and
          white on black is the highest contrast the screen can produce. The
          safelight is the house accent; this is the thing that has to work. */}
      <div className="mt-4 flex flex-col items-center">
        {mode === "photo" ? (
          <button
            type="button"
            onClick={takePhoto}
            aria-label="Take photo"
            className="rounded-full border-4 border-white/80 bg-white transition-transform active:scale-95"
            style={{ height: "4.5rem", width: "4.5rem" }}
          />
        ) : (
          <button
            type="button"
            onClick={recording ? stopRecording : startRecording}
            aria-label={recording ? "Stop recording" : "Start recording"}
            className="flex items-center justify-center rounded-full border-4 border-white/80 transition-transform active:scale-95"
            style={{ height: "4.5rem", width: "4.5rem" }}
          >
            {/* Circle idles, square records. The shape carries the state, not
                the colour — the two must be tellable apart at a glance. */}
            <span
              className={`bg-alarm transition-all duration-150 ${
                recording ? "h-6 w-6 rounded-sm" : "h-14 w-14 rounded-full"
              }`}
            />
          </button>
        )}

        {/* A film counter, not a form label. The scarcity is the product, so
            the number gets the ink and the sentence around it steps back. */}
        <p className="mt-3 text-xs text-ink-faint">
          <span className="numeric text-ink-dim">{remaining}</span>
          {" of "}
          <span className="numeric">{maxUploadsPerGuest}</span>
          {" shots left"}
          {mode === "video" && ` · up to ${MAX_VIDEO_SECONDS}s`}
        </p>
      </div>

      <QueuedShots queue={queue} />
    </div>
  )
}

/**
 * What the phone is still holding.
 *
 * Renders nothing in the ordinary case, which is the point: a guest with
 * signal should never learn that any of this exists. It appears when a shot is
 * waiting — to promise it is safe — and when one was refused for good, because
 * that is the only moment a queued shot can disappear and the guest is owed
 * the reason.
 */
function QueuedShots({ queue }: { queue: UploadQueue }) {
  if (queue.queuedCount === 0 && queue.rejected.length === 0) return null

  const one = queue.queuedCount === 1
  // Twenty shots refused for the same spent quota is one thing to say, not
  // twenty. The count is already carried by the heading.
  const reasons = [...new Set(queue.rejected.map((error) => error.message))]

  return (
    <div className="mt-3 space-y-2">
      {reasons.length > 0 && (
        <Alert
          title={
            queue.rejected.length === 1
              ? "A saved shot could not be kept."
              : `${queue.rejected.length} saved shots could not be kept.`
          }
        >
          <ul className="space-y-0.5 text-xs">
            {reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
          <button
            type="button"
            onClick={queue.dismissRejected}
            className="mt-2 text-xs underline underline-offset-2"
          >
            Got it
          </button>
        </Alert>
      )}

      {/* Waiting is not an error, so it is not alarm-coloured. It is a promise
          being kept — the shot is safe and the guest need do nothing. */}
      {queue.queuedCount > 0 && (
        <div className="flex items-center justify-between gap-3 rounded-md border border-edge bg-surface/70 px-3 py-2">
          <p className="text-xs text-ink-dim">
            {queue.flushing
              ? `Sending ${queue.queuedCount} saved ${one ? "shot" : "shots"}…`
              : `${queue.queuedCount} ${one ? "shot is" : "shots are"} safe on your phone — ${
                  one ? "it goes" : "they go"
                } up as soon as you have signal.`}
          </p>
          {!queue.flushing && (
            <button
              type="button"
              onClick={queue.flushNow}
              className="shrink-0 rounded border border-edge px-2.5 py-1 text-xs text-ink-dim transition-colors hover:border-edge-bright hover:text-ink"
            >
              Try now
            </button>
          )}
        </div>
      )}
    </div>
  )
}
