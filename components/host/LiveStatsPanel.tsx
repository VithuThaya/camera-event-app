"use client"

import { useEffect, useState } from "react"

import { formatBytes } from "@/lib/format"
import type { HostDashboard } from "@/lib/host"
import { useMoment } from "@/lib/useMoment"

/**
 * The numbers, refreshed while the host watches.
 *
 * Polling, not a subscription. The host is one person on one page, and this is
 * the only screen in the app that wants live data — a realtime channel would
 * mean opening the database to the browser, which is precisely what the whole
 * security model is built on not doing.
 *
 * The interval is slow on purpose. Nothing here rewards a fast tick: guests
 * trickle in over an evening, and a host staring at a counter is a host not
 * enjoying their own party.
 */
const POLL_INTERVAL_MS = 20_000

export function LiveStatsPanel({
  hostToken,
  initial,
}: {
  hostToken: string
  initial: HostDashboard
}) {
  // Seeded from the server render, so the first paint already carries real
  // numbers instead of skeletons that resolve a beat later.
  const [data, setData] = useState(initial)

  useEffect(() => {
    let cancelled = false

    async function poll() {
      try {
        const response = await fetch(`/api/host/${hostToken}`, { cache: "no-store" })
        if (!response.ok) return
        const fresh = (await response.json()) as HostDashboard
        // The request outlived the component — a host who tapped through to the
        // gallery mid-flight should not have this write into a dead tree.
        if (!cancelled) setData(fresh)
      } catch {
        // A failed poll just means the next one shows the truth. Nothing here is
        // worth interrupting the host over, and what is on screen is still the
        // last thing the server actually said.
      }
    }

    const timer = setInterval(poll, POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [hostToken])

  const { usage, limits } = data
  const storagePercent = Math.min(
    100,
    (usage.storageUsedBytes / limits.maxStorageBytes) * 100,
  )

  // Null until the browser has taken over — the server cannot know the host's
  // timezone, and guessing tears the panel down on hydration. See lib/useMoment.
  const deletedOn = useMoment(data.retention.deadline)

  return (
    <section className="rounded border border-neutral-800 p-4">
      <div className="grid grid-cols-2 gap-4">
        <Stat label="Guests" value={`${usage.guestCount} / ${limits.maxGuests}`} />
        <Stat label="Shots taken" value={String(usage.shotCount)} />
      </div>

      <div className="mt-5">
        <div className="flex justify-between text-xs text-neutral-500">
          <span>Storage</span>
          <span>
            {formatBytes(usage.storageUsedBytes)} of {formatBytes(limits.maxStorageBytes)}
          </span>
        </div>
        <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-neutral-800">
          <div
            className={`h-full ${storagePercent > 90 ? "bg-amber-400" : "bg-neutral-400"}`}
            style={{ width: `${storagePercent}%` }}
          />
        </div>
      </div>

      {data.retention.deadline && (
        <p className="mt-5 text-xs text-neutral-500">
          {/* The condition stays on the raw date, so this sentence exists in
              both passes and only the moment inside it arrives late. */}
          {deletedOn
            ? `Everything is deleted on ${deletedOn}.`
            : "Everything is deleted at the end of the retention window."}{" "}
          Download it before then — we keep no copy.
        </p>
      )}
    </section>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-neutral-500">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
    </div>
  )
}
