import Link from "next/link"
import { notFound } from "next/navigation"

import { DangerZone } from "@/components/host/DangerZone"
import { SettingsForm } from "@/components/host/SettingsForm"
import { buildHostDashboard, findEventByHostToken } from "@/lib/host"

// See the dashboard page: these settings are live and must never come from a
// cached render.
export const dynamic = "force-dynamic"

export default async function HostSettingsPage({
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

  return (
    <main className="mx-auto max-w-lg px-6 py-10">
      <Link href={`/host/${hostToken}`} className="text-sm text-neutral-400 underline">
        Back
      </Link>

      <h1 className="mt-4 text-2xl font-semibold">Settings</h1>
      <p className="mt-1 text-sm text-neutral-500">
        Changes apply straight away — to guests already shooting as well as new ones.
      </p>

      <div className="mt-8">
        <SettingsForm hostToken={hostToken} initial={dashboard} />
      </div>

      <div className="mt-12 border-t border-neutral-800 pt-8">
        <DangerZone hostToken={hostToken} eventName={dashboard.name} />
      </div>
    </main>
  )
}
