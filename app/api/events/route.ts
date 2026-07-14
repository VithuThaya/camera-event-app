import { NextResponse } from "next/server"

import { supabaseAdmin } from "@/lib/supabase/server"
import { generateGuestToken, generateHostToken } from "@/lib/tokens"
import { createEventSchema } from "@/lib/validation"

/**
 * POST /api/events — create an event.
 *
 * Public and unauthenticated: there are no accounts, so anyone with the URL
 * can make an event. Rate limiting and bot protection were deliberately left
 * out of the MVP (the app is being trialled on one private event); both are
 * documented fast-follows before this is shared widely.
 *
 * The response is the only time the host token is ever handed out. There is
 * no recovery path — no email, no account — so the create UI has to make
 * saving it feel non-optional.
 */

// node:crypto token generation needs the Node runtime, not Edge.
export const runtime = "nodejs"

export async function POST(request: Request) {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 })
  }

  const parsed = createEventSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid event settings.", issues: parsed.error.issues },
      { status: 400 },
    )
  }

  const input = parsed.data

  const { data, error } = await supabaseAdmin()
    .from("events")
    .insert({
      name: input.name,
      // Drawn independently. See lib/tokens.ts: the guest link goes to the
      // whole party, so it must reveal nothing about the host link.
      guest_token: generateGuestToken(),
      host_token: generateHostToken(),
      max_guests: input.maxGuests,
      max_uploads_per_guest: input.maxUploadsPerGuest,
      max_storage_bytes: input.maxStorageBytes,
      retention_days: input.retentionDays,
      unlock_at: input.unlockAt ?? null,
    })
    .select("id, guest_token, host_token")
    .single()

  if (error || !data) {
    console.error("Failed to create event:", error)
    return NextResponse.json(
      { error: "Could not create the event. Please try again." },
      { status: 500 },
    )
  }

  return NextResponse.json(
    {
      eventId: data.id,
      guestToken: data.guest_token,
      hostToken: data.host_token,
    },
    { status: 201 },
  )
}
