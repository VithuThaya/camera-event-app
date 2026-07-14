import Link from "next/link"
import { notFound } from "next/navigation"

import { GuestLink } from "@/components/host/GuestLink"
import { LiveStatsPanel } from "@/components/host/LiveStatsPanel"
import { RetentionNotice } from "@/components/host/RetentionNotice"
import { UnlockControl } from "@/components/host/UnlockControl"
import { buildHostDashboard, findEventByHostToken } from "@/lib/host"

/**
 * The host's home.
 *
 * force-dynamic because everything on this page is live and revocable. Without
 * it the full route cache can hold a render and go on serving it: the host
 * unlocks, taps back, and is told the event is still sealed — or a deleted
 * event keeps rendering from a copy nobody thinks to invalidate. The
 * router.refresh() after an unlock depends on this too.
 */
export const dynamic = "force-dynamic"

export default async function HostDashboardPage({
  params,
}: {
  params: Promise<{ hostToken: string }>
}) {
  const { hostToken } = await params

  const event = await findEventByHostToken(hostToken)
  if (!event) notFound()

  const dashboard = await buildHostDashboard(event)
  if (!dashboard) {
    return (
      <main className="mx-auto max-w-lg px-6 py-12">
        <p className="text-sm text-red-400">
          Could not load this event right now. Please refresh.
        </p>
      </main>
    )
  }

  const archived = dashboard.status === "archived"

  return (
    <main className="mx-auto max-w-lg px-6 py-10">
      <header>
        <h1 className="text-2xl font-semibold">{dashboard.name}</h1>
        <p className="mt-1 text-sm text-neutral-500">
          Only you can see this page. Keep this link to yourself.
        </p>
      </header>

      {archived && (
        <p className="mt-6 rounded border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-300">
          This event has passed its deletion date. The photos are gone — this page is
          all that is left of it.
        </p>
      )}

      {/* Only once there is something to lose. A locked event has no deadline
          at all — the clock starts at the reveal — and an archived one has
          already been swept, so the notice above is the truthful one. */}
      {!archived && dashboard.retention.deadline && (
        <RetentionNotice deadline={dashboard.retention.deadline} />
      )}

      <div className="mt-8 space-y-6">
        <LiveStatsPanel hostToken={hostToken} initial={dashboard} />

        <UnlockControl hostToken={hostToken} unlock={dashboard.unlock} />

        {dashboard.unlock.revealed && !archived && (
          <section className="grid grid-cols-2 gap-3">
            <Link
              href={`/host/${hostToken}/gallery`}
              className="rounded border border-neutral-700 px-4 py-3 text-center text-sm font-medium"
            >
              See the roll
            </Link>
            <Link
              href={`/host/${hostToken}/slideshow`}
              className="rounded bg-white px-4 py-3 text-center text-sm font-medium text-black"
            >
              Start the slideshow
            </Link>
          </section>
        )}

        {!archived && <GuestLink guestToken={dashboard.guestToken} />}

        <Link
          href={`/host/${hostToken}/settings`}
          className="block text-sm text-neutral-400 underline"
        >
          Settings
        </Link>
      </div>
    </main>
  )
}
