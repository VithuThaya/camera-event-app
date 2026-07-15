import { Alert } from "@/components/ui/Alert"
import { daysUntil } from "@/lib/format"

/**
 * The last warning anyone gets.
 *
 * Guests never see a gallery, so there is no guest-facing reminder to send and
 * no second chance to catch this: the host's dashboard is the only surface in
 * the entire product where a deletion date can be announced. If this line goes
 * unread, the photos go anyway.
 *
 * It says how long is left and not when, because the exact date is already on
 * the panel below it. A banner exists to change the temperature, not to repeat
 * the facts — and repeating them is how the two end up disagreeing after
 * someone edits one of them.
 *
 * A server component on purpose. daysUntil() measures a duration, so it is the
 * same number wherever it is computed; formatMoment() is not, and that
 * difference is exactly why the date lives elsewhere. See LiveStatsPanel.
 */

const WARN_DAYS = 7
const URGENT_DAYS = 1

export function RetentionNotice({ deadline }: { deadline: string }) {
  const days = daysUntil(deadline)

  // Weeks out, this is noise. The panel's quiet line already carries the date
  // for anyone who wants to plan around it.
  if (days > WARN_DAYS) return null

  // The deadline has passed but the sweep only runs nightly, so there is a
  // window of up to a day where the photos are still here and already
  // condemned. "0 days left" would read as a rounding error; the host needs to
  // understand this is their last chance, not a countdown.
  if (days <= 0) {
    return (
      <Banner tone="urgent">
        The deletion date has passed. Everything here is removed at the next sweep,
        tonight. Download it now, or it is gone.
      </Banner>
    )
  }

  if (days <= URGENT_DAYS) {
    return (
      <Banner tone="urgent">
        Everything is deleted tomorrow. This is the last day to download the roll —
        we keep no copy of it.
      </Banner>
    )
  }

  return (
    <Banner tone="warn">
      Everything is deleted in {days} days. Download the roll before then — we keep
      no copy of it.
    </Banner>
  )
}

function Banner({
  tone,
  children,
}: {
  tone: "warn" | "urgent"
  children: React.ReactNode
}) {
  // The safelight asks, the alarm tells. Mapped onto the shared Alert rather
  // than hand-rolled, so this cannot drift from the rest of the room — but both
  // tones are kept, because they are the difference between "plan for this" and
  // "tonight". The urgent state is the only place this deliberately quiet
  // interface raises its voice, which is exactly what makes it work.
  return (
    <Alert tone={tone === "urgent" ? "alarm" : "notice"} className="mt-6">
      {children}
    </Alert>
  )
}
