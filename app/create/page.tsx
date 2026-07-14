"use client"

import QRCode from "qrcode"
import { useState } from "react"

import { EVENT_LIMITS, STORAGE_PRESETS } from "@/lib/validation"

type CreatedEvent = {
  guestUrl: string
  hostUrl: string
  qrDataUrl: string
}

function appOrigin(): string {
  return process.env.NEXT_PUBLIC_APP_URL ?? window.location.origin
}

export default function CreateEventPage() {
  const [name, setName] = useState("")
  // EVENT_LIMITS is `as const`, so the defaults are literal types. Widening to
  // number here keeps the setters usable with arbitrary slider values.
  const [maxGuests, setMaxGuests] = useState<number>(
    EVENT_LIMITS.maxGuests.default,
  )
  const [maxUploadsPerGuest, setMaxUploadsPerGuest] = useState<number>(
    EVENT_LIMITS.maxUploadsPerGuest.default,
  )
  const [maxStorageBytes, setMaxStorageBytes] = useState<number>(
    EVENT_LIMITS.maxStorageBytes.default,
  )
  const [retentionDays, setRetentionDays] = useState<number>(
    EVENT_LIMITS.retentionDays.default,
  )
  const [unlockAtLocal, setUnlockAtLocal] = useState("")

  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [created, setCreated] = useState<CreatedEvent | null>(null)

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    setSubmitting(true)
    setError(null)

    try {
      const response = await fetch("/api/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          maxGuests,
          maxUploadsPerGuest,
          maxStorageBytes,
          retentionDays,
          // datetime-local gives a wall-clock string with no zone; the API
          // wants an instant, so resolve it against the host's own timezone.
          unlockAt: unlockAtLocal ? new Date(unlockAtLocal).toISOString() : null,
        }),
      })

      const payload = await response.json()
      if (!response.ok) {
        setError(payload.error ?? "Could not create the event.")
        return
      }

      const origin = appOrigin()
      const guestUrl = `${origin}/e/${payload.guestToken}`
      setCreated({
        guestUrl,
        hostUrl: `${origin}/host/${payload.hostToken}`,
        qrDataUrl: await QRCode.toDataURL(guestUrl, { width: 512, margin: 2 }),
      })
    } catch {
      setError("Network error. Please try again.")
    } finally {
      setSubmitting(false)
    }
  }

  if (created) {
    return <CreatedView created={created} />
  }

  return (
    <main className="mx-auto max-w-lg px-6 py-12">
      <h1 className="text-2xl font-semibold">Create your event</h1>
      <p className="mt-2 text-sm text-neutral-400">
        Set the rules once. Guests just scan and shoot.
      </p>

      <form onSubmit={handleSubmit} className="mt-8 space-y-6">
        <Field label="Event name">
          <input
            required
            maxLength={120}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Anna & Max's Wedding"
            className="w-full rounded border border-neutral-700 bg-neutral-900 px-3 py-2"
          />
        </Field>

        <Field
          label={`Max guests: ${maxGuests}`}
          hint="How many people can join with the link."
        >
          <input
            type="range"
            min={EVENT_LIMITS.maxGuests.min}
            max={EVENT_LIMITS.maxGuests.max}
            value={maxGuests}
            onChange={(e) => setMaxGuests(Number(e.target.value))}
            className="w-full"
          />
        </Field>

        <Field
          label={`Shots per guest: ${maxUploadsPerGuest}`}
          hint="Fewer shots is the point. Scarcity makes people think before they tap."
        >
          <input
            type="range"
            min={EVENT_LIMITS.maxUploadsPerGuest.min}
            max={EVENT_LIMITS.maxUploadsPerGuest.max}
            value={maxUploadsPerGuest}
            onChange={(e) => setMaxUploadsPerGuest(Number(e.target.value))}
            className="w-full"
          />
        </Field>

        <Field label="Storage for this event">
          <select
            value={maxStorageBytes}
            onChange={(e) => setMaxStorageBytes(Number(e.target.value))}
            className="w-full rounded border border-neutral-700 bg-neutral-900 px-3 py-2"
          >
            {STORAGE_PRESETS.map((preset) => (
              <option key={preset.bytes} value={preset.bytes}>
                {preset.label}
              </option>
            ))}
          </select>
        </Field>

        <Field
          label="Unlock at (optional)"
          hint="Leave empty to unlock by hand whenever you want. Nobody sees a single shot until then."
        >
          <input
            type="datetime-local"
            value={unlockAtLocal}
            onChange={(e) => setUnlockAtLocal(e.target.value)}
            className="w-full rounded border border-neutral-700 bg-neutral-900 px-3 py-2"
          />
        </Field>

        <Field
          label={`Delete after ${retentionDays} days`}
          hint="Counted from the moment you unlock. Download everything before then."
        >
          <input
            type="range"
            min={EVENT_LIMITS.retentionDays.min}
            max={90}
            value={retentionDays}
            onChange={(e) => setRetentionDays(Number(e.target.value))}
            className="w-full"
          />
        </Field>

        {error && (
          <p className="rounded border border-red-900 bg-red-950 px-3 py-2 text-sm text-red-300">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={submitting || !name.trim()}
          className="w-full rounded bg-white px-4 py-3 font-medium text-black disabled:opacity-40"
        >
          {submitting ? "Creating…" : "Create event"}
        </button>
      </form>
    </main>
  )
}

function CreatedView({ created }: { created: CreatedEvent }) {
  return (
    <main className="mx-auto max-w-lg px-6 py-12">
      <h1 className="text-2xl font-semibold">Your event is live</h1>

      {/* The host link is shown exactly once and cannot be recovered: there is
          no account and no email to send it to. Saying so plainly here is the
          only thing standing between the host and a lost event. */}
      <div className="mt-6 rounded border border-amber-700 bg-amber-950/40 p-4">
        <p className="font-medium text-amber-200">Save your host link now</p>
        <p className="mt-1 text-sm text-amber-100/80">
          It is the only way back into your event — to unlock the photos,
          download them, or change the rules. We cannot send it to you again or
          recover it if you lose it.
        </p>
        <CopyRow label="Host link (keep private)" value={created.hostUrl} />
      </div>

      <div className="mt-8">
        <h2 className="font-medium">Share with your guests</h2>
        <p className="mt-1 text-sm text-neutral-400">
          Anyone with this link or QR code can add shots. No app, no signup.
        </p>
        {/* eslint-disable-next-line @next/next/no-img-element -- data: URL built in-browser; nothing for the image optimizer to fetch */}
        <img
          src={created.qrDataUrl}
          alt="QR code linking guests to this event"
          className="mt-4 w-64 rounded bg-white p-3"
        />
        <CopyRow label="Guest link" value={created.guestUrl} />
      </div>
    </main>
  )
}

function CopyRow({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false)

  return (
    <div className="mt-3">
      <p className="text-xs uppercase tracking-wide text-neutral-500">{label}</p>
      <div className="mt-1 flex gap-2">
        <input
          readOnly
          value={value}
          onFocus={(e) => e.currentTarget.select()}
          className="w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1 font-mono text-xs"
        />
        <button
          type="button"
          onClick={async () => {
            await navigator.clipboard.writeText(value)
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
          }}
          className="shrink-0 rounded border border-neutral-700 px-3 py-1 text-xs"
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
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
      {hint && (
        <span className="mt-0.5 block text-xs text-neutral-500">{hint}</span>
      )}
      <div className="mt-2">{children}</div>
    </label>
  )
}
