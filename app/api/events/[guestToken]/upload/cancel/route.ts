import { NextResponse } from "next/server"

import { findConsentedGuest } from "@/lib/events"
import { MEDIA_BUCKET } from "@/lib/storagePaths"
import { supabaseAdmin } from "@/lib/supabase/server"
import { uploadConfirmSchema } from "@/lib/validation"

/**
 * Throws away a clip that was uploaded for review but not kept.
 *
 * The review screen uploads a clip before the guest has decided (so iOS can
 * play it back over HTTPS — see upload/preview-url). When they retake instead
 * of keeping, that pending object has to go, and go now: reserve_media_upload
 * counts pending rows against the guest's slot cap for a full hour, so leaving
 * it would quietly cost the guest a shot until the retention sweep caught up.
 *
 * Only a pending row the guest owns can be cancelled. A confirmed row is a kept
 * shot and is refused — deletion of kept media is the host's business, not a
 * capture-screen action.
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

  const { data: media, error: lookupError } = await supabaseAdmin()
    .from("media_items")
    .select("id, storage_path, status")
    .eq("id", parsed.data.mediaId)
    .eq("event_id", guest.event.id)
    .eq("guest_session_id", guest.guestSessionId)
    .maybeSingle()

  if (lookupError) {
    console.error("Failed to load media item:", lookupError)
    return NextResponse.json({ error: "Could not cancel upload" }, { status: 500 })
  }
  // Already gone (a double-tap, or swept). Nothing to do, and saying so is the
  // truth — the slot is free either way.
  if (!media) {
    return NextResponse.json({ ok: true })
  }
  if (media.status !== "pending") {
    return NextResponse.json({ error: "Already kept", code: "already_kept" }, { status: 409 })
  }

  // Object first, then the row. If the object remove fails the row delete still
  // frees the slot, and the orphaned object is swept on its own; the reverse —
  // a freed object with a live row — would keep charging the guest for nothing.
  await supabaseAdmin().storage.from(MEDIA_BUCKET).remove([media.storage_path])

  const { error: deleteError } = await supabaseAdmin()
    .from("media_items")
    .delete()
    .eq("id", media.id)
    .eq("event_id", guest.event.id)
    .eq("guest_session_id", guest.guestSessionId)
    .eq("status", "pending")

  if (deleteError) {
    console.error("Failed to delete pending media item:", deleteError)
    return NextResponse.json({ error: "Could not cancel upload" }, { status: 500 })
  }

  return NextResponse.json({ ok: true })
}
