import { redirect } from "next/navigation"

import { CameraCapture } from "@/components/camera/CameraCapture"
import { findConsentedGuest } from "@/lib/events"
import { supabaseAdmin } from "@/lib/supabase/server"

/**
 * The camera.
 *
 * Consent is re-checked here rather than trusted from the referring page,
 * because this URL is guessable to anyone holding the guest token — and the
 * consent record is the entire lawful basis for keeping a photo of someone.
 *
 * Anyone without a consented session goes back to the join screen rather than
 * a 404: the common cause is a real guest whose cookie expired, and the join
 * screen is exactly where they need to land.
 */

export default async function CapturePage({
  params,
}: {
  params: Promise<{ guestToken: string }>
}) {
  const { guestToken } = await params

  const guest = await findConsentedGuest(guestToken)
  if (!guest) redirect(`/e/${guestToken}`)

  // The starting count only. From here the component tracks it client-side for
  // display, while every upload is decided server-side against this same row.
  const { data } = await supabaseAdmin()
    .from("guest_sessions")
    .select("upload_count")
    .eq("id", guest.guestSessionId)
    .maybeSingle()

  return (
    /* Tight padding and a one-line header: the viewfinder is the screen. Every
       pixel here exists to give the camera as much of the phone as it can get. */
    <main className="mx-auto flex min-h-dvh max-w-md flex-col px-3 py-4">
      <header className="mb-3 flex items-baseline justify-between gap-3">
        <h1 className="truncate text-sm font-medium text-ink-dim">{guest.event.name}</h1>
        <p className="shrink-0 text-xs text-ink-faint">Nobody sees these yet</p>
      </header>

      <CameraCapture
        guestToken={guestToken}
        maxUploadsPerGuest={guest.event.max_uploads_per_guest}
        initialUploadCount={data?.upload_count ?? 0}
      />
    </main>
  )
}
