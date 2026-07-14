import { NextResponse } from "next/server"

import { countGuestSessions, findActiveEventByGuestToken } from "@/lib/events"
import { readGuestSession, setGuestSession } from "@/lib/session"
import { supabaseAdmin } from "@/lib/supabase/server"

/**
 * POST /api/events/[guestToken]/consent — join the event.
 *
 * This is where a guest actually comes into being: it creates their
 * guest_sessions row, stamps consent, and hands back the signed cookie that
 * carries their upload quota.
 *
 * Consent is recorded server-side rather than trusted from the client because
 * it is the GDPR record that the guest was told what the camera would do
 * before it was switched on. Phase 2's upload routes refuse to issue an upload
 * URL while consent_ack_at is null, so a client that skips this screen cannot
 * upload anything.
 */

export const runtime = "nodejs"

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ guestToken: string }> },
) {
  const { guestToken } = await params

  const event = await findActiveEventByGuestToken(guestToken)
  if (!event) {
    return NextResponse.json({ error: "Event not found." }, { status: 404 })
  }

  // Already joined: re-acknowledging is a no-op, not a second session. This
  // keeps a double-tap or a page refresh from minting a fresh quota.
  const existing = await readGuestSession(event.id)
  if (existing) {
    await supabaseAdmin()
      .from("guest_sessions")
      .update({ last_seen_at: new Date().toISOString() })
      .eq("id", existing.guestSessionId)

    return NextResponse.json({ ok: true }, { status: 200 })
  }

  if ((await countGuestSessions(event.id)) >= event.max_guests) {
    return NextResponse.json(
      { error: "This event has reached its guest limit." },
      { status: 403 },
    )
  }

  const { data, error } = await supabaseAdmin()
    .from("guest_sessions")
    .insert({
      event_id: event.id,
      consent_ack_at: new Date().toISOString(),
    })
    .select("id")
    .single()

  if (error || !data) {
    console.error("Failed to create guest session:", error)
    return NextResponse.json(
      { error: "Could not join the event. Please try again." },
      { status: 500 },
    )
  }

  await setGuestSession({ eventId: event.id, guestSessionId: data.id })

  return NextResponse.json({ ok: true }, { status: 201 })
}
