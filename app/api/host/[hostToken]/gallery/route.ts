import { NextResponse } from "next/server"

import { MEDIA_URL_TTL_SECONDS, gateHostMedia, listConfirmedMedia } from "@/lib/host"

/**
 * GET /api/host/[hostToken]/gallery — the roll, once it is unlocked.
 *
 * The plan called for a second /slideshow route "tuned for sequential
 * consumption". It is deliberately not built. Both views want the same thing —
 * every confirmed shot, in the order it was taken, with a URL that works — and
 * a slideshow's differences (auto-advance, prefetch, fullscreen) are all things
 * the client does with that list, not things the server sends differently.
 *
 * The reason to collapse them is not tidiness. A second route is a second place
 * the reveal gate has to be remembered, and the one that gets forgotten is the
 * one that serves the whole party's photos to anyone holding the link. One
 * route, one gate, no way for the two to drift apart.
 */

export const runtime = "nodejs"

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ hostToken: string }> },
) {
  const { hostToken } = await params

  const gate = await gateHostMedia(hostToken)
  if (!gate.ok) {
    if (gate.reason === "locked") {
      // 403, not 404: the event is real and this caller is its host. There is
      // nothing to be coy about — they are the one who can lift this.
      return NextResponse.json(
        { error: "This event is still locked.", code: "locked" },
        { status: 403 },
      )
    }
    return NextResponse.json({ error: "Not found" }, { status: 404 })
  }

  const items = await listConfirmedMedia(gate.event.id)
  if (!items) {
    return NextResponse.json({ error: "Could not load the gallery." }, { status: 500 })
  }

  return NextResponse.json(
    {
      eventName: gate.event.name,
      items,
      // When these URLs die. The client refetches before then, rather than
      // discovering it as a wall of broken images halfway through a party.
      expiresInSeconds: MEDIA_URL_TTL_SECONDS,
    },
    {
      headers: {
        // Every URL in this body is a bearer credential for one object. Letting
        // a proxy keep this response would hand them out again later — after
        // the event was deleted, or after the retention sweep ran.
        "Cache-Control": "no-store, private",
      },
    },
  )
}
