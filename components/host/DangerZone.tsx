"use client"

import { useRouter } from "next/navigation"
import { useState } from "react"

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

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-sm text-red-400 underline"
      >
        Delete this event
      </button>
    )
  }

  return (
    <div className="rounded border border-red-900 bg-red-950/40 p-4">
      <h2 className="font-medium text-red-200">Delete this event</h2>
      <p className="mt-1 text-sm text-red-100/80">
        Every photo and video is erased from our servers immediately, the guest link
        stops working, and your host link stops working. There is no undo and we keep
        no copy. If you have not downloaded the roll yet, do that first.
      </p>

      <label className="mt-4 block text-sm">
        Type <span className="font-mono text-red-200">{eventName}</span> to confirm
        <input
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
          className="mt-1.5 w-full rounded border border-red-900 bg-neutral-900 px-3 py-2"
        />
      </label>

      {error && <p className="mt-3 text-sm text-red-300">{error}</p>}

      <div className="mt-4 flex gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            setOpen(false)
            setTyped("")
            setError(null)
          }}
          className="flex-1 rounded border border-neutral-700 px-3 py-2 text-sm disabled:opacity-40"
        >
          Keep it
        </button>
        <button
          type="button"
          disabled={busy || typed.trim() !== eventName.trim()}
          onClick={handleDelete}
          className="flex-1 rounded bg-red-500 px-3 py-2 text-sm font-medium text-white disabled:opacity-40"
        >
          {busy ? "Deleting…" : "Delete forever"}
        </button>
      </div>
    </div>
  )
}
