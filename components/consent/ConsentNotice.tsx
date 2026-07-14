"use client"

import { useRouter } from "next/navigation"
import { useState } from "react"

/**
 * The GDPR notice, shown before the camera is ever requested.
 *
 * Photos of identifiable people are personal data, so the guest has to be told
 * what happens to them — and told it in plain words, before the fact, not
 * buried in a policy nobody opens. Accepting is what creates their session
 * server-side; the timestamp is the record that they were asked.
 */

export function ConsentNotice({
  guestToken,
  eventName,
  maxUploadsPerGuest,
  retentionDays,
}: {
  guestToken: string
  eventName: string
  maxUploadsPerGuest: number
  retentionDays: number
}) {
  const router = useRouter()
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function accept() {
    setSubmitting(true)
    setError(null)

    try {
      const response = await fetch(`/api/events/${guestToken}/consent`, {
        method: "POST",
      })

      if (!response.ok) {
        const payload = await response.json().catch(() => ({}))
        setError(payload.error ?? "Could not join the event.")
        return
      }

      router.replace(`/e/${guestToken}/capture`)
      router.refresh()
    } catch {
      setError("Network error. Please try again.")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-6 py-12">
      <p className="text-xs uppercase tracking-widest text-neutral-500">
        You are invited to shoot
      </p>
      <h1 className="mt-2 text-3xl font-semibold">{eventName}</h1>

      <div className="mt-8 space-y-4 text-sm text-neutral-300">
        <Point title={`You get ${maxUploadsPerGuest} shots`}>
          That is the whole point. Fewer shots, better shots — make them count.
        </Point>
        <Point title="Nobody sees them until the host unlocks">
          Not the other guests, not even you. Your photos go straight into the
          host&apos;s locked roll.
        </Point>
        <Point title="The host collects them, not you">
          Only the host can view and download the roll after the unlock. They
          decide how to show it — a slideshow at the party, or shared later.
        </Point>
        <Point title="We strip location data">
          GPS metadata is removed from every photo before it is stored.
        </Point>
        <Point title={`Everything is deleted after ${retentionDays} days`}>
          Counted from the unlock. After that it is gone from our servers for
          good.
        </Point>
      </div>

      <p className="mt-6 text-xs text-neutral-500">
        No account, no signup, no name or email collected. Tapping below turns
        on your camera and records that you agreed to the above.
      </p>

      {error && (
        <p className="mt-4 rounded border border-red-900 bg-red-950 px-3 py-2 text-sm text-red-300">
          {error}
        </p>
      )}

      <button
        type="button"
        onClick={accept}
        disabled={submitting}
        className="mt-6 w-full rounded bg-white px-4 py-3 font-medium text-black disabled:opacity-40"
      >
        {submitting ? "Joining…" : "Agree and open camera"}
      </button>
    </main>
  )
}

function Point({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <div>
      <p className="font-medium text-neutral-100">{title}</p>
      <p className="mt-0.5 text-neutral-400">{children}</p>
    </div>
  )
}
