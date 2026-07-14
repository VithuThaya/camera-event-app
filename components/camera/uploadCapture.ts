/**
 * The three-step upload, client side: reserve, PUT, confirm.
 *
 * The bytes go straight from the phone to Storage over a signed URL, because
 * a 15s clip is far larger than a route handler will accept as a request body.
 * Our server bookends it: init decides whether the guest may shoot at all, and
 * confirm is what actually strips metadata and moves the counters. A file that
 * lands in the bucket without a successful confirm is invisible and gets swept
 * within the hour, so a half-finished upload leaves nothing behind.
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

export async function uploadCapture(
  guestToken: string,
  capture: Capture,
  onProgress?: (fraction: number) => void,
): Promise<void> {
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

  const confirmResponse = await postJson(`/api/events/${guestToken}/upload/confirm`, {
    mediaId,
  })
  if (!confirmResponse.ok) throw await rejectionFrom(confirmResponse)
}
