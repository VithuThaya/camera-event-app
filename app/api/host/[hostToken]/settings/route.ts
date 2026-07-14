import { NextResponse } from "next/server"

import { findEventByHostToken } from "@/lib/host"
import { supabaseAdmin } from "@/lib/supabase/server"
import { hostSettingsSchema } from "@/lib/validation"

/**
 * PATCH /api/host/[hostToken]/settings — change the rules mid-event.
 *
 * Lowering a limit below what has already happened is allowed, and that is
 * deliberate. A host who drops the shot cap to 5 after some guests have taken
 * 12 is not making a mistake — they are saying "that's enough". Nobody loses a
 * shot they already took; the cap only decides who may take another, and the
 * database settles that per upload anyway (`update … where upload_count < max`).
 *
 * Storage is the one exception, below.
 */

export const runtime = "nodejs"

export async function PATCH(
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

  const parsed = hostSettingsSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid settings.", issues: parsed.error.issues },
      { status: 400 },
    )
  }

  const input = parsed.data

  // A storage cap below what is already stored would wedge the event: every
  // upload from that moment on fails confirm's storage check, and the host
  // would read a healthy-looking dashboard while every guest silently hit
  // "this event is out of storage". Refuse it, with the number that explains
  // why, rather than accept a setting that only breaks later somewhere else.
  if (input.maxStorageBytes < event.storage_used_bytes) {
    return NextResponse.json(
      {
        error: "That is less storage than this event has already used.",
        code: "below_storage_used",
        storageUsedBytes: event.storage_used_bytes,
      },
      { status: 400 },
    )
  }

  const { data, error } = await supabaseAdmin()
    .from("events")
    .update({
      name: input.name,
      max_guests: input.maxGuests,
      max_uploads_per_guest: input.maxUploadsPerGuest,
      max_storage_bytes: input.maxStorageBytes,
      retention_days: input.retentionDays,
    })
    .eq("id", event.id)
    // Selecting the row back means a write that matched nothing surfaces here
    // instead of returning a cheerful 200 over a change that never happened.
    .select("name, max_guests, max_uploads_per_guest, max_storage_bytes, retention_days")
    .maybeSingle()

  if (error || !data) {
    console.error("Failed to update settings:", error)
    return NextResponse.json({ error: "Could not save the settings." }, { status: 500 })
  }

  return NextResponse.json({
    ok: true,
    name: data.name,
    limits: {
      maxGuests: data.max_guests,
      maxUploadsPerGuest: data.max_uploads_per_guest,
      maxStorageBytes: data.max_storage_bytes,
      retentionDays: data.retention_days,
    },
  })
}
