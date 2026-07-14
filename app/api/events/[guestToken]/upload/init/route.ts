import { NextResponse } from "next/server"

import { findConsentedGuest } from "@/lib/events"
import { MEDIA_BUCKET, mediaStoragePath, normalizeMimeType } from "@/lib/storagePaths"
import { supabaseAdmin } from "@/lib/supabase/server"
import { uploadInitSchema } from "@/lib/validation"

/**
 * Reserves a shot and hands back a one-use upload URL.
 *
 * The bytes do not pass through here. A 15s clip runs to tens of megabytes and
 * this route handler has a request body limit well under that, so the browser
 * PUTs straight to Storage using a signed URL we mint. That is the one place
 * the client legitimately talks to Supabase, and it can only reach the single
 * object path named in the signature.
 *
 * Nothing is visible to anyone at this point: the row is 'pending', the bucket
 * is private, and the host gallery only ever lists 'confirmed'.
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

  const parsed = uploadInitSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid upload", details: parsed.error.issues },
      { status: 400 },
    )
  }

  // The declared size is a courtesy check so an oversized file is refused
  // before it is uploaded rather than after. Storage enforces its own ceiling,
  // and confirm re-reads the real size from the bucket, so a client lying here
  // gains nothing.
  const mimeType = normalizeMimeType(parsed.data.mimeType)
  const storagePath = mediaStoragePath(guest.event.id, mimeType)

  const { data: mediaId, error: reserveError } = await supabaseAdmin().rpc(
    "reserve_media_upload",
    {
      p_event_id: guest.event.id,
      p_guest_session_id: guest.guestSessionId,
      p_storage_path: storagePath,
      p_media_type: parsed.data.mediaType,
      p_mime_type: mimeType,
      p_size_bytes: parsed.data.sizeBytes,
      // undefined, not null: the RPC argument is optional and defaults to null
      // in SQL. Photos legitimately have no duration.
      p_duration_seconds: parsed.data.durationSeconds ?? undefined,
    },
  )

  if (reserveError) {
    if (reserveError.message.includes("upload_quota_exceeded")) {
      return NextResponse.json(
        { error: "You have used all of your shots", code: "upload_quota_exceeded" },
        { status: 403 },
      )
    }
    console.error("Failed to reserve upload:", reserveError)
    return NextResponse.json({ error: "Could not start upload" }, { status: 500 })
  }

  const { data: signed, error: signError } = await supabaseAdmin()
    .storage.from(MEDIA_BUCKET)
    .createSignedUploadUrl(storagePath)

  if (signError || !signed) {
    // The reservation is left behind deliberately rather than deleted: it will
    // be swept as a stale pending row within the hour, and unwinding it here
    // would need a second failure path of its own.
    console.error("Failed to sign upload URL:", signError)
    return NextResponse.json({ error: "Could not start upload" }, { status: 500 })
  }

  return NextResponse.json({
    mediaId,
    path: storagePath,
    uploadUrl: signed.signedUrl,
    token: signed.token,
  })
}
