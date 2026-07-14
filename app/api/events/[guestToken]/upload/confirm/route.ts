import { NextResponse } from "next/server"

import { MetadataStillPresentError, NotAPhotoError, stripPhotoMetadata } from "@/lib/exif"
import { findConsentedGuest } from "@/lib/events"
import { MEDIA_BUCKET } from "@/lib/storagePaths"
import { supabaseAdmin } from "@/lib/supabase/server"
import { MEDIA_LIMITS, uploadConfirmSchema } from "@/lib/validation"

/**
 * Turns an uploaded object into a kept shot.
 *
 * This is where the promises are actually kept, in this order:
 *   - the object really landed (a client can call confirm without uploading)
 *   - its real size comes from Storage, not from what the client claimed
 *   - a photo's metadata is stripped before anything is recorded as confirmed
 *   - the quota counters move atomically, or nothing moves
 *
 * Photos are re-encoded server-side and written back over the same path, so
 * the un-stripped original does not survive. It sits in the bucket for the few
 * hundred milliseconds in between, which is safe because the bucket is private
 * and its row is still 'pending' — nothing lists it, nothing can sign a URL to
 * it, and the retention sweep removes it if we crash right here.
 */

export const runtime = "nodejs"

export async function POST(
  request: Request,
  { params }: { params: Promise<{ guestToken: string }> },
) {
  const { guestToken } = await params

  const guest = await findConsentedGuest(guestToken)
  if (!guest) {
    return NextResponse.json({ error: "Not found" }, { status: 404 })
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 })
  }

  const parsed = uploadConfirmSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 })
  }

  // Ownership is part of the query. Someone else's mediaId reads as "not
  // found", which is also the honest answer: it is not theirs to confirm.
  const { data: media, error: lookupError } = await supabaseAdmin()
    .from("media_items")
    .select("id, storage_path, media_type, status")
    .eq("id", parsed.data.mediaId)
    .eq("event_id", guest.event.id)
    .eq("guest_session_id", guest.guestSessionId)
    .maybeSingle()

  if (lookupError) {
    console.error("Failed to load media item:", lookupError)
    return NextResponse.json({ error: "Could not confirm upload" }, { status: 500 })
  }
  if (!media) {
    return NextResponse.json({ error: "Not found" }, { status: 404 })
  }
  if (media.status !== "pending") {
    // Already confirmed. Report success rather than an error: the common cause
    // is a retry after a dropped response, and the guest's photo is safe.
    // The RPC would refuse a second increment anyway.
    return NextResponse.json({ ok: true, alreadyConfirmed: true })
  }

  const { data: blob, error: downloadError } = await supabaseAdmin()
    .storage.from(MEDIA_BUCKET)
    .download(media.storage_path)

  if (downloadError || !blob) {
    // The signed URL was issued but nothing was PUT to it, or the upload
    // failed. Not an error on our side; the reservation expires on its own.
    return NextResponse.json(
      { error: "Upload did not complete", code: "object_missing" },
      { status: 400 },
    )
  }

  const original = Buffer.from(await blob.arrayBuffer())
  const isPhoto = media.media_type === "photo"

  let bytes: Buffer = original
  if (isPhoto) {
    try {
      bytes = await stripPhotoMetadata(original)
    } catch (error) {
      if (error instanceof NotAPhotoError || error instanceof MetadataStillPresentError) {
        // Refuse rather than keep it. A file we cannot strip is a file we
        // cannot promise anything about, and the whole point of the reveal is
        // that the host gets material that is safe to show.
        await supabaseAdmin().storage.from(MEDIA_BUCKET).remove([media.storage_path])
        return NextResponse.json(
          { error: "That file could not be processed", code: "unprocessable_media" },
          { status: 400 },
        )
      }
      console.error("Failed to strip photo metadata:", error)
      return NextResponse.json({ error: "Could not confirm upload" }, { status: 500 })
    }

    // update() rather than upload({ upsert: true }): both replace the object,
    // but update() means what we mean here — the object exists, we just
    // downloaded it, and we are replacing its contents. It fails if the object
    // is gone, which upsert would paper over by recreating it.
    const { error: reuploadError } = await supabaseAdmin()
      .storage.from(MEDIA_BUCKET)
      .update(media.storage_path, bytes, { contentType: "image/jpeg" })

    if (reuploadError) {
      // Leaving the un-stripped original in place while recording the row as
      // confirmed would be the one outcome we must never produce.
      console.error("Failed to write stripped photo:", reuploadError)
      return NextResponse.json({ error: "Could not confirm upload" }, { status: 500 })
    }
  }

  // Size as Storage has it, now that stripping is done. The bucket enforces
  // its own 40 MiB ceiling on the way in; this catches the narrower per-type
  // limits the bucket cannot express.
  const limit = isPhoto ? MEDIA_LIMITS.photo.maxBytes : MEDIA_LIMITS.video.maxBytes
  if (bytes.byteLength > limit) {
    await supabaseAdmin().storage.from(MEDIA_BUCKET).remove([media.storage_path])
    return NextResponse.json(
      { error: "That file is too large", code: "too_large" },
      { status: 400 },
    )
  }

  const { error: confirmError } = await supabaseAdmin().rpc("confirm_media_upload", {
    p_media_id: media.id,
    p_event_id: guest.event.id,
    p_guest_session_id: guest.guestSessionId,
    p_size_bytes: bytes.byteLength,
    // Honest, not aspirational: videos are not stripped. See lib/exif.ts.
    p_exif_stripped: isPhoto,
  })

  if (confirmError) {
    const message = confirmError.message
    if (message.includes("upload_quota_exceeded")) {
      await supabaseAdmin().storage.from(MEDIA_BUCKET).remove([media.storage_path])
      return NextResponse.json(
        { error: "You have used all of your shots", code: "upload_quota_exceeded" },
        { status: 403 },
      )
    }
    if (message.includes("storage_quota_exceeded")) {
      await supabaseAdmin().storage.from(MEDIA_BUCKET).remove([media.storage_path])
      return NextResponse.json(
        { error: "This event is out of storage", code: "storage_quota_exceeded" },
        { status: 403 },
      )
    }
    if (message.includes("media_item_not_pending")) {
      return NextResponse.json({ ok: true, alreadyConfirmed: true })
    }
    console.error("Failed to confirm upload:", confirmError)
    return NextResponse.json({ error: "Could not confirm upload" }, { status: 500 })
  }

  return NextResponse.json({ ok: true, exifStripped: isPhoto })
}
