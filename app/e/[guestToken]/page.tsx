import { notFound, redirect } from "next/navigation"

import { ConsentNotice } from "@/components/consent/ConsentNotice"
import { countGuestSessions, findActiveEventByGuestToken } from "@/lib/events"
import { readGuestSession } from "@/lib/session"
import { supabaseAdmin } from "@/lib/supabase/server"

/**
 * Where a scanned QR code lands.
 *
 * A guest who has already joined goes straight to the camera. A new one has to
 * pass the consent notice first — the camera is never reachable without it,
 * and Phase 2's upload routes independently refuse anyone whose
 * consent_ack_at is null, so skipping this screen client-side buys nothing.
 */

export default async function GuestLandingPage({
  params,
}: {
  params: Promise<{ guestToken: string }>
}) {
  const { guestToken } = await params

  const event = await findActiveEventByGuestToken(guestToken)
  if (!event) notFound()

  const session = await readGuestSession(event.id)

  if (session) {
    const { data } = await supabaseAdmin()
      .from("guest_sessions")
      .select("consent_ack_at")
      .eq("id", session.guestSessionId)
      .maybeSingle()

    if (data?.consent_ack_at) {
      redirect(`/e/${guestToken}/capture`)
    }
  }

  // Only new guests can be turned away at the door. Someone already inside
  // keeps their session even if the host later lowers the limit.
  if (!session && (await countGuestSessions(event.id)) >= event.max_guests) {
    return (
      <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-6">
        <h1 className="text-2xl font-semibold">{event.name}</h1>
        <p className="mt-3 text-neutral-400">
          This event is full — it has reached its guest limit. Ask the host to
          raise it if you should be in.
        </p>
      </main>
    )
  }

  return (
    <ConsentNotice
      guestToken={guestToken}
      eventName={event.name}
      maxUploadsPerGuest={event.max_uploads_per_guest}
      retentionDays={event.retention_days}
    />
  )
}
