"use client"

import { useRouter } from "next/navigation"
import { useState } from "react"

import { formatBytes } from "@/lib/format"
import type { HostDashboard } from "@/lib/host"
import { EVENT_LIMITS, STORAGE_PRESETS } from "@/lib/validation"

/**
 * The rules, after the event is already running.
 *
 * The same knobs as the create form, minus the ones that stopped being knobs:
 * the unlock lives on the dashboard because it is an act rather than a setting,
 * and the tokens are not here at all — the guest link is already on a QR code
 * taped to a table, so "rotating" it would only lock the party out.
 */
export function SettingsForm({
  hostToken,
  initial,
}: {
  hostToken: string
  initial: HostDashboard
}) {
  const router = useRouter()
  const [name, setName] = useState(initial.name)
  const [maxGuests, setMaxGuests] = useState(initial.limits.maxGuests)
  const [maxUploadsPerGuest, setMaxUploadsPerGuest] = useState(
    initial.limits.maxUploadsPerGuest,
  )
  const [maxStorageBytes, setMaxStorageBytes] = useState(initial.limits.maxStorageBytes)
  const [retentionDays, setRetentionDays] = useState(initial.limits.retentionDays)

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    setSaved(false)

    try {
      const response = await fetch(`/api/host/${hostToken}/settings`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          maxGuests,
          maxUploadsPerGuest,
          maxStorageBytes,
          retentionDays,
        }),
      })
      const payload = await response.json()
      if (!response.ok) {
        setError(payload.error ?? "Could not save.")
        return
      }
      setSaved(true)
      router.refresh()
    } catch {
      setError("Network error. Please try again.")
    } finally {
      setBusy(false)
    }
  }

  // Offering a cap the event has already outgrown would only earn a rejection
  // from the server, so do not offer it. The server still checks — this is the
  // courtesy, not the rule.
  const usablePresets = STORAGE_PRESETS.filter(
    (preset) => preset.bytes >= initial.usage.storageUsedBytes,
  )

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <Field label="Event name">
        <input
          required
          maxLength={120}
          value={name}
          onChange={(event) => setName(event.target.value)}
          className="w-full rounded border border-neutral-700 bg-neutral-900 px-3 py-2"
        />
      </Field>

      <Field
        label={`Max guests: ${maxGuests}`}
        hint={`${initial.usage.guestCount} have joined. Lowering this turns away new guests; the ones already in keep their shots.`}
      >
        <input
          type="range"
          min={EVENT_LIMITS.maxGuests.min}
          max={EVENT_LIMITS.maxGuests.max}
          value={maxGuests}
          onChange={(event) => setMaxGuests(Number(event.target.value))}
          className="w-full"
        />
      </Field>

      <Field
        label={`Shots per guest: ${maxUploadsPerGuest}`}
        hint="Lowering this never takes a shot back. It only decides who may take another."
      >
        <input
          type="range"
          min={EVENT_LIMITS.maxUploadsPerGuest.min}
          max={EVENT_LIMITS.maxUploadsPerGuest.max}
          value={maxUploadsPerGuest}
          onChange={(event) => setMaxUploadsPerGuest(Number(event.target.value))}
          className="w-full"
        />
      </Field>

      <Field
        label="Storage for this event"
        hint={`${formatBytes(initial.usage.storageUsedBytes)} used so far.`}
      >
        <select
          value={maxStorageBytes}
          onChange={(event) => setMaxStorageBytes(Number(event.target.value))}
          className="w-full rounded border border-neutral-700 bg-neutral-900 px-3 py-2"
        >
          {usablePresets.map((preset) => (
            <option key={preset.bytes} value={preset.bytes}>
              {preset.label}
            </option>
          ))}
        </select>
      </Field>

      <Field
        label={`Delete after ${retentionDays} days`}
        hint={
          initial.unlock.revealed
            ? "Counted from the moment you unlocked. Changing it moves the deletion date."
            : "The countdown does not start until you unlock."
        }
      >
        <input
          type="range"
          min={EVENT_LIMITS.retentionDays.min}
          max={90}
          value={retentionDays}
          onChange={(event) => setRetentionDays(Number(event.target.value))}
          className="w-full"
        />
      </Field>

      {error && (
        <p className="rounded border border-red-900 bg-red-950 px-3 py-2 text-sm text-red-300">
          {error}
        </p>
      )}
      {saved && <p className="text-sm text-green-400">Saved.</p>}

      <button
        type="submit"
        disabled={busy || !name.trim()}
        className="w-full rounded bg-white px-4 py-3 font-medium text-black disabled:opacity-40"
      >
        {busy ? "Saving…" : "Save settings"}
      </button>
    </form>
  )
}

function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <label className="block">
      <span className="text-sm font-medium">{label}</span>
      {hint && <span className="mt-0.5 block text-xs text-neutral-500">{hint}</span>}
      <div className="mt-2">{children}</div>
    </label>
  )
}
