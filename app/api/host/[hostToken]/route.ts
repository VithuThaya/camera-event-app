import { NextResponse } from "next/server"

import { buildHostDashboard, findEventByHostToken } from "@/lib/host"
import { purgeEventMedia } from "@/lib/purge"
import { supabaseAdmin } from "@/lib/supabase/server"
import { deleteEventSchema } from "@/lib/validation"

/**
 * GET    /api/host/[hostToken] — everything the dashboard shows.
 * DELETE /api/host/[hostToken] — destroy the event and its media.
 */

export const runtime = "nodejs"

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ hostToken: string }> },
) {
  const { hostToken } = await params

  const event = await findEventByHostToken(hostToken)
  if (!event) {
    return NextResponse.json({ error: "Not found" }, { status: 404 })
  }

  const dashboard = await buildHostDashboard(event)
  if (!dashboard) {
    return NextResponse.json({ error: "Could not load the dashboard." }, { status: 500 })
  }

  return NextResponse.json(dashboard, {
    // Carries the guest token and the event's live counts. Nothing between here
    // and the host has any business keeping a copy.
    headers: { "Cache-Control": "no-store, private" },
  })
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ hostToken: string }> },
) {
  const { hostToken } = await params

  const event = await findEventByHostToken(hostToken)
  if (!event) {
    return NextResponse.json({ error: "Not found" }, { status: 404 })
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 })
  }

  const parsed = deleteEventSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 })
  }

  // The name is not a secret — it is printed on the QR poster. It is a speed
  // bump, and that is exactly the job: the host token alone can destroy an
  // event, so the request has to prove it knows which event it is destroying.
  if (parsed.data.confirmName.trim() !== event.name.trim()) {
    return NextResponse.json(
      { error: "That name does not match this event.", code: "name_mismatch" },
      { status: 400 },
    )
  }

  // Bytes first, rows second. If this dies in between, the media is already
  // gone and a retry finishes the paperwork. The other order would mark the
  // event deleted while the guests' photos were still sitting in the bucket —
  // the one outcome that turns "deleted" into a lie.
  const purged = await purgeEventMedia(event.id)
  if (!purged) {
    return NextResponse.json(
      { error: "Could not delete the media. Nothing was changed — please try again." },
      { status: 500 },
    )
  }

  const deletedAt = new Date().toISOString()

  const { error: mediaError } = await supabaseAdmin()
    .from("media_items")
    .update({ status: "deleted", deleted_at: deletedAt })
    .eq("event_id", event.id)
    .neq("status", "deleted")

  if (mediaError) {
    console.error("Failed to mark media deleted:", mediaError)
    return NextResponse.json({ error: "Could not delete the event." }, { status: 500 })
  }

  // This is what shuts the door on the guests: findActiveEventByGuestToken
  // requires status='active' and a null deleted_at, so every guest link for
  // this event stops resolving the moment this lands.
  const { error: eventError } = await supabaseAdmin()
    .from("events")
    .update({ status: "deleted", deleted_at: deletedAt })
    .eq("id", event.id)

  if (eventError) {
    console.error("Failed to mark event deleted:", eventError)
    return NextResponse.json({ error: "Could not delete the event." }, { status: 500 })
  }

  return NextResponse.json({ ok: true, removed: purged.removed })
}
