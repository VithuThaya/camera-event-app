"use client"

import { useRouter } from "next/navigation"
import { useState } from "react"

import { Alert } from "@/components/ui/Alert"
import { Button } from "@/components/ui/Button"

/**
 * Deleting the event.
 *
 * The typed name is not security theatre, and it is not a secret — it is
 * printed on the QR poster. It is here because this button destroys photographs
 * that cannot be taken again, belonging to people who are not in the room, and
 * the host token alone is enough to press it. Making the host name what they
 * are destroying is the difference between a decision and a slip.
 *
 * The server checks the same name. This copy is the courtesy; that one is the
 * rule.
 */
export function DangerZone({
  hostToken,
  eventName,
}: {
  hostToken: string
  eventName: string
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [typed, setTyped] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleDelete() {
    setBusy(true)
    setError(null)
    try {
      const response = await fetch(`/api/host/${hostToken}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmName: typed }),
      })
      const payload = await response.json()
      if (!response.ok) {
        setError(payload.error ?? "Could not delete the event.")
        return
      }
      // There is nowhere to go back to: this token now resolves to nothing.
      router.replace("/")
    } catch {
      setError("Network error. Please try again.")
    } finally {
      setBusy(false)
    }
  }

  // Closed, this is a line of text rather than a button competing for
  // attention. It sits at the bottom of the settings page and should be
  // findable by anyone looking for it and invisible to everyone else.
  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-sm text-alarm/80 underline underline-offset-4 transition-colors hover:text-alarm"
      >
        Delete this event
      </button>
    )
  }

  return (
    <div className="rounded-lg border border-alarm/35 bg-alarm-deep/25 p-4">
      <h2 className="font-medium text-alarm">Delete this event</h2>
      {/* Full-strength ink, not alarm-tinted. This is the paragraph that has to
          actually be read, and red text on a red wash is the least readable
          thing on the page — the colour is the room's job here, not the type's. */}
      <p className="mt-1 text-sm text-ink">
        Every photo and video is erased from our servers immediately, the guest link
        stops working, and your host link stops working. There is no undo and we keep
        no copy. If you have not downloaded the roll yet, do that first.
      </p>

      <label className="mt-4 block text-sm text-ink-dim">
        {/* font-mono, not .numeric: this is a literal string to be copied by
            eye, and .numeric carries tabular figures — meaningless on a name,
            and it visibly spaces out the punctuation in one like "Anna & Ben". */}
        Type <span className="font-mono text-ink">{eventName}</span> to confirm
        <input
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
          className="mt-1.5 w-full rounded-md border border-alarm/35 bg-ground px-3 py-2 text-ink"
        />
      </label>

      {error && <Alert className="mt-3">{error}</Alert>}

      <div className="mt-4 flex gap-2">
        <Button
          variant="quiet"
          disabled={busy}
          onClick={() => {
            setOpen(false)
            setTyped("")
            setError(null)
          }}
          className="flex-1"
        >
          Keep it
        </Button>
        {/* Solid alarm, not the outlined danger variant. Everything else in this
            app is a step that can be walked back; this is the only control that
            ends something for good, so it is the only one painted in. */}
        <button
          type="button"
          disabled={busy || typed.trim() !== eventName.trim()}
          onClick={handleDelete}
          className="inline-flex min-h-11 flex-1 items-center justify-center rounded-md bg-alarm px-3 py-2 text-sm font-medium text-ground transition-colors hover:bg-alarm/90 disabled:pointer-events-none disabled:opacity-40"
        >
          {busy ? "Deleting…" : "Delete forever"}
        </button>
      </div>
    </div>
  )
}
