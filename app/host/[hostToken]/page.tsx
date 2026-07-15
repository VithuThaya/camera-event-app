import Link from "next/link"
import { notFound } from "next/navigation"

import { GuestLink } from "@/components/host/GuestLink"
import { LiveStatsPanel } from "@/components/host/LiveStatsPanel"
import { RetentionNotice } from "@/components/host/RetentionNotice"
import { UnlockControl } from "@/components/host/UnlockControl"
import { Alert } from "@/components/ui/Alert"
import { buttonStyles } from "@/components/ui/Button"
import { Eyebrow } from "@/components/ui/Panel"
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
        <Alert>Could not load this event right now. Please refresh.</Alert>
      </main>
    )
  }

  const archived = dashboard.status === "archived"

  return (
    <main className="mx-auto max-w-lg px-6 py-10">
      <header>
        <Eyebrow>Your event</Eyebrow>
        <h1 className="mt-2 text-2xl font-semibold text-balance">{dashboard.name}</h1>
        <p className="mt-1 text-sm text-ink-faint">
          Only you can see this page. Keep this link to yourself.
        </p>
      </header>

      {/* Not an alarm. The bad news already happened and there is nothing left
          to act on — this is an epitaph and should read like one, rather than
          shout at someone who can no longer do anything about it. */}
      {archived && (
        <p className="mt-6 rounded-md border border-edge bg-surface px-3 py-2 text-sm text-ink-dim">
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

        {/* Once the roll is open, the slideshow is what the host came for —
            it is the payoff the whole product is built around, so it is the
            one lit thing here. Browsing is the calmer sibling. */}
        {dashboard.unlock.revealed && !archived && (
          <section className="grid grid-cols-2 gap-3">
            <Link
              href={`/host/${hostToken}/gallery`}
              className={buttonStyles("quiet")}
            >
              See the roll
            </Link>
            <Link href={`/host/${hostToken}/slideshow`} className={buttonStyles()}>
              Start the slideshow
            </Link>
          </section>
        )}

        {!archived && <GuestLink guestToken={dashboard.guestToken} />}

        <Link
          href={`/host/${hostToken}/settings`}
          className="block text-sm text-ink-faint underline underline-offset-4 transition-colors hover:text-ink-dim"
        >
          Settings
        </Link>
      </div>
    </main>
  )
}
