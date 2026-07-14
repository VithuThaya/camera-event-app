import { NextResponse } from "next/server"

import { countGuestSessions, findActiveEventByGuestToken } from "@/lib/events"
import { readGuestSession } from "@/lib/session"
import { supabaseAdmin } from "@/lib/supabase/server"

/**
 * GET /api/events/[guestToken] — what a guest is allowed to know.
 *
 * Read-only by design. The plan originally had this create the guest session,
 * but that would make a GET state-changing: a cross-site navigation could then
 * burn guest slots against the host's max_guests. Session creation lives in
 * POST /consent instead, where SameSite=Lax withholds the cookie from
 * cross-site callers.
 *
 * Nothing about the event's contents is exposed here — not a count, not a
 * thumbnail. Guests never see the gallery at all; only the host does, and only
 * after unlock.
 */

export const runtime = "nodejs"

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ guestToken: string }> },
) {
  const { guestToken } = await params

  const event = await findActiveEventByGuestToken(guestToken)
  // Unknown, malformed, deleted, and archived all answer identically, so a
  // scanner cannot tell a real event from a miss.
  if (!event) {
    return NextResponse.json({ error: "Event not found." }, { status: 404 })
  }

  const session = await readGuestSession(event.id)

  let uploadsUsed = 0
  let consentAcknowledged = false

  if (session) {
    const { data } = await supabaseAdmin()
      .from("guest_sessions")
      .select("upload_count, consent_ack_at")
      .eq("id", session.guestSessionId)
      .maybeSingle()

    uploadsUsed = data?.upload_count ?? 0
    consentAcknowledged = Boolean(data?.consent_ack_at)
  }

  // Capacity only blocks *new* guests. Someone who already joined keeps their
  // session even if the host later lowers max_guests below the current count.
  const atCapacity =
    !session && (await countGuestSessions(event.id)) >= event.max_guests

  return NextResponse.json({
    name: event.name,
    maxUploadsPerGuest: event.max_uploads_per_guest,
    uploadsUsed,
    uploadsRemaining: Math.max(0, event.max_uploads_per_guest - uploadsUsed),
    hasSession: Boolean(session),
    consentAcknowledged,
    atCapacity,
  })
}
