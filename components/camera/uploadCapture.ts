/**
 * The three-step upload, client side: reserve, PUT, confirm.
 *
 * The bytes go straight from the phone to Storage over a signed URL, because
 * a 15s clip is far larger than a route handler will accept as a request body.
 * Our server bookends it: init decides whether the guest may shoot at all, and
 * confirm is what actually strips metadata and moves the counters. A file that
 * lands in the bucket without a successful confirm is invisible to everyone —
 * no signed URL is ever minted for it — and the nightly sweep takes it once it
 * is an hour old, so a half-finished upload leaves nothing behind.
 *
 * The steps are exposed separately as well as composed, because the offline
 * queue has to be able to stop between them and resume later. The seam sits
 * after the PUT rather than after init, and that placement is the whole reason
 * a queued shot cannot cost a guest two of their allowance:
 *
 *   - Bytes not in the bucket yet? The reservation is worthless to a retry —
 *     a signed upload URL lives 60 seconds — and it is also harmless: no
 *     counter has moved, and confirm refuses a row whose object is missing.
 *     So the retry starts over from init and the orphan is swept within a day.
 *   - Bytes already in the bucket? That work must not be thrown away, and it
 *     need not be: confirm is idempotent server-side, so a retry that cannot
 *     tell whether the first confirm landed can simply ask again.
 *
 * lib/offline/flush.ts is the only caller that needs the distinction.
 */

export type Capture = {
  blob: Blob
  mediaType: "photo" | "video"
  mimeType: string
  durationSeconds?: number
}

/**
 * The server considered the request and said no: out of shots, event full,
 * file too large. Retrying verbatim will fail the same way, so the UI shows
 * the message and stops.
 */
export class UploadRejectedError extends Error {
  constructor(
    message: string,
    readonly code: string | undefined,
    readonly status: number,
  ) {
    super(message)
  }
}

/**
 * Nothing was decided — the request never got an answer. Separate from
 * UploadRejectedError because this is the case that is worth retrying, and the
 * one Phase 4 hands to the offline queue. Treating a rejection as retryable
 * would make a guest's phone hammer a request that can never succeed; treating
 * a dropped connection as a rejection would throw away their photo.
 */
export class UploadNetworkError extends Error {}

async function postJson(url: string, body: unknown): Promise<Response> {
  try {
    return await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  } catch {
    throw new UploadNetworkError("Could not reach the server")
  }
}

async function rejectionFrom(response: Response): Promise<UploadRejectedError> {
  const payload = await response.json().catch(() => ({}))
  return new UploadRejectedError(
    payload.error ?? "Upload failed",
    payload.code,
    response.status,
  )
}

/**
 * PUT with progress.
 *
 * XMLHttpRequest rather than fetch: fetch cannot report upload progress, and a
 * 40 MB clip on party wifi with no progress bar reads as a frozen app, which
 * is how you get a guest force-quitting mid-upload.
 */
function putWithProgress(
  url: string,
  blob: Blob,
  contentType: string,
  onProgress?: (fraction: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open("PUT", url)
    xhr.setRequestHeader("content-type", contentType)

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && onProgress) {
        onProgress(event.loaded / event.total)
      }
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve()
        return
      }
      // Storage refused the object itself — wrong type, over the bucket
      // ceiling, or an expired signature. Not retryable as-is.
      reject(
        new UploadRejectedError(
          "Storage rejected the file",
          "storage_rejected",
          xhr.status,
        ),
      )
    }
    xhr.onerror = () => reject(new UploadNetworkError("Upload connection failed"))
    xhr.onabort = () => reject(new UploadNetworkError("Upload was interrupted"))
    xhr.ontimeout = () => reject(new UploadNetworkError("Upload timed out"))

    xhr.send(blob)
  })
}

/**
 * Reserve a shot and get the bytes into the bucket.
 *
 * Resolves with the mediaId only once the PUT has actually landed, which is
 * what makes the returned value safe to persist: it means "the bytes are up,
 * only confirm is left". A mediaId that escaped this function on its way to
 * disk would be a promise nobody can keep.
 */
export async function reserveAndPut(
  guestToken: string,
  capture: Capture,
  onProgress?: (fraction: number) => void,
): Promise<string> {
  const initResponse = await postJson(`/api/events/${guestToken}/upload/init`, {
    mediaType: capture.mediaType,
    mimeType: capture.mimeType,
    sizeBytes: capture.blob.size,
    durationSeconds: capture.durationSeconds ?? null,
  })
  if (!initResponse.ok) throw await rejectionFrom(initResponse)

  const { mediaId, uploadUrl } = await initResponse.json()

  // The bare type, matching what the bucket's allowed_mime_types accepts and
  // what the server recorded at init. Sending "video/webm;codecs=vp8" here is
  // refused by Storage.
  const contentType = capture.mimeType.split(";")[0]!.trim()
  await putWithProgress(uploadUrl, capture.blob, contentType, onProgress)

  return mediaId
}

/**
 * Keep the shot: strip it, count it, make it real.
 *
 * Safe to call twice for the same mediaId — the server answers a second
 * confirm with `alreadyConfirmed` rather than an error, and refuses to move
 * the counters again. That is what lets a retry ask "did it land?" by simply
 * trying once more.
 */
export async function confirmUpload(guestToken: string, mediaId: string): Promise<void> {
  const confirmResponse = await postJson(`/api/events/${guestToken}/upload/confirm`, {
    mediaId,
  })
  if (!confirmResponse.ok) throw await rejectionFrom(confirmResponse)
}

export async function uploadCapture(
  guestToken: string,
  capture: Capture,
  onProgress?: (fraction: number) => void,
): Promise<void> {
  const mediaId = await reserveAndPut(guestToken, capture, onProgress)
  await confirmUpload(guestToken, mediaId)
}

/**
 * A read URL for a clip that is uploaded but not yet kept, so iOS can play it
 * back over HTTPS in the review screen — it will not play the same bytes from a
 * blob: URL. Only valid while the row is pending; keeping or cancelling ends it.
 *
 * Throws UploadRejectedError with code "object_missing" if the bytes are not in
 * the bucket yet (the caller should keep showing the still), and
 * UploadNetworkError if the request never landed.
 */
export async function fetchPreviewUrl(guestToken: string, mediaId: string): Promise<string> {
  const response = await postJson(`/api/events/${guestToken}/upload/preview-url`, { mediaId })
  if (!response.ok) throw await rejectionFrom(response)
  const { url } = await response.json()
  return url
}

/**
 * Throw away a clip that was uploaded for review but not kept.
 *
 * Best-effort by design: a pending object left behind is swept within the hour,
 * so a failed cancel is a slow cleanup, never a lost shot or a wrong counter.
 * The caller does not wait on it or surface its failure.
 */
export async function cancelPending(guestToken: string, mediaId: string): Promise<void> {
  try {
    await postJson(`/api/events/${guestToken}/upload/cancel`, { mediaId })
  } catch {
    // Swallowed on purpose — see above.
  }
}
