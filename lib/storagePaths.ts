import { randomUUID } from "node:crypto"

/**
 * Where media lives in the bucket, and how a MIME type maps to a name.
 *
 * Kept apart from the routes because the guest side writes these paths and the
 * host side (Phase 3) reads them back. If the two ever disagreed about the
 * layout, uploads would succeed and the gallery would silently come up empty.
 */

export const MEDIA_BUCKET = "event-media"

/**
 * MediaRecorder hands back types like "video/webm;codecs=vp8,opus". The codec
 * parameters are real information, but the bucket's allowed_mime_types list
 * matches on the bare type, so an unnormalised value is rejected at upload
 * with an error that looks nothing like its cause.
 */
export function normalizeMimeType(value: string): string {
  return value.split(";")[0]!.trim().toLowerCase()
}

const EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "video/webm": "webm",
  "video/mp4": "mp4",
}

export function extensionForMime(mimeType: string): string | null {
  return EXTENSIONS[normalizeMimeType(mimeType)] ?? null
}

/**
 * A fresh random object name per upload.
 *
 * Deliberately not derived from the media_items id, the guest session, or the
 * capture order. The bucket is private and every read is a signed URL, so the
 * path is not a secret in itself — but a guessable one would turn any future
 * bucket misconfiguration from "nothing leaks" into "the whole event leaks",
 * and it would leak who shot what and in which order. Random costs nothing.
 */
export function mediaStoragePath(eventId: string, mimeType: string): string {
  const ext = extensionForMime(mimeType)
  if (!ext) throw new Error(`Unsupported media type: ${mimeType}`)
  return `events/${eventId}/${randomUUID()}.${ext}`
}
