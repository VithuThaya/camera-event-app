"use client"

import { useRouter } from "next/navigation"
import { useState } from "react"

import { Alert } from "@/components/ui/Alert"
import { Button } from "@/components/ui/Button"
import { Eyebrow } from "@/components/ui/Panel"

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
      <Eyebrow>You are invited to shoot</Eyebrow>
      <h1 className="mt-2 text-3xl font-semibold text-balance">{eventName}</h1>

      <div className="mt-8 space-y-4 text-sm">
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
        <Point title="We strip location data from photos">
          GPS and camera details are removed from every photo on our servers
          before it is stored. Video is different: it records sound, and we do
          not strip its metadata yet — shoot a photo if that matters to you.
        </Point>
        <Point title={`Everything is deleted after ${retentionDays} days`}>
          Counted from the unlock. After that it is gone from our servers for
          good.
        </Point>
      </div>

      <p className="mt-6 text-xs text-ink-faint">
        No account, no signup, no name or email collected. Tapping below turns
        on your camera and records that you agreed to the above.
      </p>

      {error && <Alert className="mt-4">{error}</Alert>}

      <Button onClick={accept} disabled={submitting} className="mt-6 w-full">
        {submitting ? "Joining…" : "Agree and open camera"}
      </Button>
    </main>
  )
}

/**
 * One promise, and what it actually means.
 *
 * The title carries full-strength ink and the explanation sits a step back —
 * so the five promises can be read on their own in a couple of seconds, with
 * the detail there for anyone who stops. This is a legal notice people are
 * genuinely expected to read, which is exactly why it gets no cleverness.
 */
function Point({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <div>
      <p className="font-medium text-ink">{title}</p>
      <p className="mt-0.5 text-ink-dim">{children}</p>
    </div>
  )
}
