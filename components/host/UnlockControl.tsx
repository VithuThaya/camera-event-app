"use client"

import { useRouter } from "next/navigation"
import { useState } from "react"

import { Alert } from "@/components/ui/Alert"
import { Button } from "@/components/ui/Button"
import { Panel } from "@/components/ui/Panel"
import { useMoment } from "@/lib/useMoment"
import type { HostDashboard } from "@/lib/host"

/**
 * The one irreversible control in the app.
 *
 * Unlocking cannot be undone: the server refuses to re-lock a revealed event,
 * because once the host has seen the film there is nothing left to protect and
 * a lock icon over an open door is a lie. That is what earns the second tap
 * here — not nagging, but the fact that "open it now" and "cancel the schedule"
 * sit inches apart and only one of them is permanent.
 */
export function UnlockControl({
  hostToken,
  unlock,
}: {
  hostToken: string
  unlock: HostDashboard["unlock"]
}) {
  const router = useRouter()
  const [scheduleLocal, setScheduleLocal] = useState("")
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Above the early return, because hooks cannot be called conditionally — and
  // null until the browser takes over, since the server cannot know the host's
  // timezone and guessing tears this panel down on hydration. See lib/useMoment.
  const openedAt = useMoment(unlock.unlockedAt)
  const opensAt = useMoment(unlock.unlockAt)

  async function send(body: unknown) {
    setBusy(true)
    setError(null)
    try {
      const response = await fetch(`/api/host/${hostToken}/unlock`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      const payload = await response.json()
      if (!response.ok) {
        setError(payload.error ?? "That did not work.")
        return
      }
      setConfirming(false)
      setScheduleLocal("")
      // The page is server-rendered from the database, so re-render it rather
      // than patch a local copy that could drift from what the gate really says.
      router.refresh()
    } catch {
      setError("Network error. Please try again.")
    } finally {
      setBusy(false)
    }
  }

  if (unlock.revealed) {
    return (
      <Panel>
        <h2 className="font-medium text-ink">Unlocked</h2>
        <p className="mt-1 text-sm text-ink-dim">
          {/* Each condition stays on the raw date, so the sentence keeps its
              shape across both render passes and only the moment arrives late. */}
          {unlock.unlockedAt
            ? openedAt
              ? `You opened the roll on ${openedAt}.`
              : "You opened the roll."
            : unlock.unlockAt
              ? opensAt
                ? `It opened on schedule at ${opensAt}.`
                : "It opened on schedule."
              : "The roll is open."}{" "}
          Guests can still add shots — the slideshow grows as the night goes on.
        </p>
      </Panel>
    )
  }

  return (
    <Panel>
      <h2 className="font-medium text-ink">Still sealed</h2>
      <p className="mt-1 text-sm text-ink-dim">
        {unlock.unlockAt
          ? opensAt
            ? `Opens by itself on ${opensAt}.`
            : "Opens by itself at the time you set."
          : "Nothing opens until you say so."}{" "}
        Nobody has seen a single shot — including you.
      </p>

      {error && <Alert className="mt-3">{error}</Alert>}

      <div className="mt-4">
        {confirming ? (
          /* The only red on the dashboard, and it is spent here rather than on
             "Unlock now" above — that button opens this dialog and undoes
             nothing. This is the tap that cannot be taken back. */
          <div className="rounded-md border border-alarm/35 bg-alarm-deep/25 p-3">
            <p className="text-sm text-ink">
              This cannot be undone. Once the roll is open it stays open, and the
              deletion countdown starts from this moment.
            </p>
            <div className="mt-3 flex gap-2">
              <Button variant="quiet" disabled={busy} onClick={() => setConfirming(false)} className="flex-1">
                Not yet
              </Button>
              <Button variant="danger" disabled={busy} onClick={() => send({ mode: "now" })} className="flex-1">
                {busy ? "Opening…" : "Open it"}
              </Button>
            </div>
          </div>
        ) : (
          <Button disabled={busy} onClick={() => setConfirming(true)} className="w-full">
            Unlock now
          </Button>
        )}
      </div>

      <div className="mt-6 border-t border-edge pt-4">
        <label className="block text-sm font-medium text-ink" htmlFor="unlock-at">
          Or open it automatically
        </label>
        <div className="mt-2 flex gap-2">
          <input
            id="unlock-at"
            type="datetime-local"
            value={scheduleLocal}
            onChange={(event) => setScheduleLocal(event.target.value)}
            className="w-full rounded-md border border-edge bg-ground px-3 py-2 text-sm text-ink"
          />
          <button
            type="button"
            disabled={busy || !scheduleLocal}
            onClick={() =>
              // datetime-local hands back wall-clock text with no zone. The API
              // wants an instant, so resolve it against the host's own clock —
              // the one they had in mind when they typed it.
              send({ mode: "schedule", unlockAt: new Date(scheduleLocal).toISOString() })
            }
            className="shrink-0 rounded-md border border-edge px-3 py-2 text-sm text-ink transition-colors hover:border-edge-bright disabled:opacity-40"
          >
            Set
          </button>
        </div>
        {unlock.unlockAt && (
          <button
            type="button"
            disabled={busy}
            onClick={() => send({ mode: "cancel" })}
            className="mt-2 text-xs text-ink-faint underline underline-offset-2 transition-colors hover:text-ink-dim disabled:opacity-40"
          >
            Cancel the schedule and open it by hand instead
          </button>
        )}
      </div>
    </Panel>
  )
}
