import { notFound, redirect } from "next/navigation"

import { findActiveEventByGuestToken } from "@/lib/events"
import { readGuestSession } from "@/lib/session"
import { supabaseAdmin } from "@/lib/supabase/server"

/**
 * The camera. Phase 2 fills this in; the gate around it is already real.
 *
 * Consent is re-checked here rather than trusted from the referring page,
 * because this URL is guessable once someone has the guest token.
 */

export default async function CapturePage({
  params,
}: {
  params: Promise<{ guestToken: string }>
}) {
  const { guestToken } = await params

  const event = await findActiveEventByGuestToken(guestToken)
  if (!event) notFound()

  const session = await readGuestSession(event.id)
  if (!session) redirect(`/e/${guestToken}`)

  const { data } = await supabaseAdmin()
    .from("guest_sessions")
    .select("upload_count, consent_ack_at")
    .eq("id", session.guestSessionId)
    .maybeSingle()

  // A session whose row is gone (event deleted, or a stale cookie) is not a
  // session. Send them back through the door.
  if (!data?.consent_ack_at) redirect(`/e/${guestToken}`)

  const remaining = Math.max(0, event.max_uploads_per_guest - data.upload_count)

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-6 py-12">
      <h1 className="text-2xl font-semibold">{event.name}</h1>
      <p className="mt-2 text-sm text-neutral-400">
        {remaining} of {event.max_uploads_per_guest} shots left
      </p>

      <div className="mt-8 rounded border border-dashed border-neutral-700 p-8 text-center">
        <p className="text-sm text-neutral-500">
          Camera arrives in Phase 2 — capture, local preview, confirm, upload.
        </p>
      </div>
    </main>
  )
}
