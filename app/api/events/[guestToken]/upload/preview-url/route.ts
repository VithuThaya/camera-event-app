import { NextResponse } from "next/server"

import { findConsentedGuest } from "@/lib/events"
import { MEDIA_BUCKET } from "@/lib/storagePaths"
import { supabaseAdmin } from "@/lib/supabase/server"
import { uploadConfirmSchema } from "@/lib/validation"

/**
 * A short-lived read URL for a clip that is uploaded but not yet kept.
 *
 * This exists for one reason: iOS will not play a freshly recorded clip from a
 * blob: URL in memory, but it plays the identical bytes without complaint once
 * they are served over HTTPS. So the review screen uploads the clip to its
 * pending object first and plays it back through a signed URL — the same path
 * the slideshow uses for confirmed media, pointed at a row that is still
 * 'pending' and invisible to everyone else.
 *
 * Only the owning guest, and only while the row is still pending, can mint one.
 * The instant the shot is kept it becomes confirmed and this route stops
 * answering for it; a discarded shot is deleted outright by upload/cancel.
 */

export const runtime = "nodejs"

// Long enough to review and decide, short enough that a leaked URL is worthless
// by the time anyone finds it. The object it points at is swept within the hour
// regardless if the shot is never kept.
const PREVIEW_URL_TTL_SECONDS = 600

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

  // Ownership is part of the query, and so is 'pending': someone else's clip, or
  // one that has already been kept, is simply "not found" here.
  const { data: media, error: lookupError } = await supabaseAdmin()
    .from("media_items")
    .select("id, storage_path, status")
    .eq("id", parsed.data.mediaId)
    .eq("event_id", guest.event.id)
    .eq("guest_session_id", guest.guestSessionId)
    .maybeSingle()

  if (lookupError) {
    console.error("Failed to load media item:", lookupError)
    return NextResponse.json({ error: "Could not prepare preview" }, { status: 500 })
  }
  if (!media || media.status !== "pending") {
    return NextResponse.json({ error: "Not found" }, { status: 404 })
  }

  const { data: signed, error: signError } = await supabaseAdmin()
    .storage.from(MEDIA_BUCKET)
    .createSignedUrl(media.storage_path, PREVIEW_URL_TTL_SECONDS)

  if (signError || !signed) {
    // The object may not be in the bucket yet — the client asks for this only
    // after its PUT has resolved, but a signed URL cannot be minted for bytes
    // that are not there. The caller falls back to the still frame.
    return NextResponse.json({ error: "Preview not ready", code: "object_missing" }, { status: 409 })
  }

  return NextResponse.json({ url: signed.signedUrl })
}
