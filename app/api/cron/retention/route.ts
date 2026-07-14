import { timingSafeEqual } from "node:crypto"
import { NextResponse } from "next/server"

import { runRetentionSweep } from "@/lib/retention"

/**
 * GET /api/cron/retention — the nightly sweep, triggered by Vercel Cron.
 *
 * The most destructive route in the app: it deletes people's photographs, and
 * unlike every other route here it answers to no token belonging to anyone. So
 * the shared secret is the entire gate, and it is treated like one.
 *
 * GET, not POST, because that is what Vercel Cron sends — a POST route would
 * simply never fire. It is not a safe GET in the HTTP sense, which is worth
 * knowing: nothing may ever prefetch or cache this URL. Hence force-dynamic,
 * and the fact that the path is guessable but the secret is not.
 */

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

// Vercel's Hobby ceiling. A sweep that outgrows 60s leaves events for the next
// night rather than half-finishing one, because each event is archived only
// after its own bytes are already gone.
export const maxDuration = 60

/**
 * Constant-time check of the shared secret.
 *
 * Vercel attaches `Authorization: Bearer $CRON_SECRET` to cron invocations.
 * A plain === would leak the secret one byte at a time to anyone willing to
 * measure the response, and this secret is worth stealing: it deletes every
 * expired event on demand.
 */
function isAuthorizedCron(request: Request): boolean {
  const secret = process.env.CRON_SECRET

  // Fail closed. An unset secret must never read as "no check required" — that
  // is the difference between a misconfigured deploy and a public endpoint that
  // erases a wedding.
  if (!secret) {
    console.error("CRON_SECRET is not set; refusing to run the retention sweep.")
    return false
  }

  const header = request.headers.get("authorization")
  if (!header) return false

  const expected = Buffer.from(`Bearer ${secret}`)
  const actual = Buffer.from(header)

  // timingSafeEqual throws on a length mismatch, so lengths must be compared
  // first. That leaks the length of the secret and nothing else, which the
  // header's own shape already gives away.
  if (expected.length !== actual.length) return false
  return timingSafeEqual(expected, actual)
}

export async function GET(request: Request) {
  if (!isAuthorizedCron(request)) {
    // No detail, deliberately: a caller without the secret learns nothing about
    // whether it was missing, malformed, or merely wrong — nor even that a cron
    // route lives here.
    return NextResponse.json({ error: "Not found" }, { status: 404 })
  }

  const report = await runRetentionSweep()
  if (!report) {
    // Both halves failed outright — the database was unreachable, not "there
    // was nothing to do". A 500 is what makes this visible in Vercel's cron log
    // instead of passing for a quiet night.
    return NextResponse.json({ error: "The sweep could not run." }, { status: 500 })
  }

  // Logged as well as returned: nobody reads an HTTP response from a cron job,
  // and this is the only standing record that the promise in the consent notice
  // is actually being kept.
  console.log("Retention sweep:", JSON.stringify(report))

  return NextResponse.json(
    { ok: true, ...report },
    { headers: { "Cache-Control": "no-store" } },
  )
}
