import { NextResponse } from "next/server"

import { isEventUnlocked } from "@/lib/events"
import { findEventByHostToken } from "@/lib/host"
import { supabaseAdmin } from "@/lib/supabase/server"
import { unlockSchema } from "@/lib/validation"

/**
 * POST /api/host/[hostToken]/unlock — break the seal, or schedule when it breaks.
 *
 * This is the hinge the whole product turns on, so two properties matter more
 * than anything else here:
 *
 *   unlocked_at is stamped exactly once. It is the instant the retention clock
 *   counts from, so moving it moves the deletion date. Every write that could
 *   set it carries "and the event is still locked" in its WHERE clause, so two
 *   racing requests cannot both stamp it, and a request arriving a second after
 *   a scheduled reveal cannot restamp it later than it really happened.
 *
 *   A revealed event cannot be re-locked. Once the host has seen the film there
 *   is nothing left to protect, and pretending otherwise would put a lock icon
 *   on a door that is already open.
 */

export const runtime = "nodejs"

export async function POST(
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

  const parsed = unlockSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid unlock request.", issues: parsed.error.issues },
      { status: 400 },
    )
  }

  const alreadyRevealed = isEventUnlocked(event)
  const nowIso = new Date().toISOString()

  /**
   * "The event is still locked", expressed as a filter instead of trusted from
   * the row we read a moment ago. isEventUnlocked() is this same rule in
   * TypeScript; this is the rule at the one place it can be held against a
   * concurrent writer.
   */
  const whileLocked = () =>
    supabaseAdmin()
      .from("events")
      .update(
        parsed.data.mode === "now"
          ? { is_unlocked: true, unlocked_at: nowIso }
          : { unlock_at: parsed.data.mode === "schedule" ? parsed.data.unlockAt : null },
      )
      .eq("id", event.id)
      .eq("is_unlocked", false)
      .or(`unlock_at.is.null,unlock_at.gt.${nowIso}`)
      .select("is_unlocked, unlock_at, unlocked_at")
      .maybeSingle()

  if (parsed.data.mode === "now") {
    if (alreadyRevealed) {
      // Idempotent rather than an error: the usual cause is a double tap or a
      // retry after a dropped response, and the honest answer is that what the
      // host asked for is already true. Re-stamping unlocked_at here would
      // quietly push the deletion date back.
      return NextResponse.json({ ok: true, alreadyUnlocked: true })
    }

    const { data, error } = await whileLocked()

    if (error) {
      console.error("Failed to unlock event:", error)
      return NextResponse.json({ error: "Could not unlock the event." }, { status: 500 })
    }
    if (!data) {
      // Nothing matched, so the event stopped being locked between our read and
      // our write — a racing request, or a scheduled reveal that just landed.
      // Either way it is open, and the stamp belongs to whoever got there first.
      return NextResponse.json({ ok: true, alreadyUnlocked: true })
    }

    return NextResponse.json({ ok: true, ...data })
  }

  // schedule and cancel only mean anything while the film is still sealed.
  if (alreadyRevealed) {
    return NextResponse.json(
      {
        error: "This event is already unlocked. It cannot be locked again.",
        code: "already_unlocked",
      },
      { status: 409 },
    )
  }

  const { data, error } = await whileLocked()

  if (error) {
    console.error("Failed to change unlock schedule:", error)
    return NextResponse.json({ error: "Could not save the schedule." }, { status: 500 })
  }
  if (!data) {
    // The event unlocked underneath us. Refusing is the only correct answer —
    // succeeding would re-hide media that has already been revealed.
    return NextResponse.json(
      {
        error: "This event unlocked while you were changing it.",
        code: "already_unlocked",
      },
      { status: 409 },
    )
  }

  return NextResponse.json({ ok: true, ...data })
}
