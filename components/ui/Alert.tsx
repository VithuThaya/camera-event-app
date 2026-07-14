import type { ReactNode } from "react"

/**
 * Something went wrong, or something needs saying.
 *
 * There were four copies of the same red box before this, three of them in the
 * capture screen alone. That matters more than it looks: the capture screen is
 * where a guest is told a shot was refused, and four independently maintained
 * versions of "bad news" is four chances for one of them to end up unreadable
 * against the room.
 *
 * `tone` has two values, because there are only two things to say. `alarm` is a
 * shot lost or refused. `notice` is a deadline the host still has time to act
 * on — a retention countdown is not an error, and painting it red teaches
 * people to ignore red.
 */
export function Alert({
  tone = "alarm",
  title,
  children,
  className = "",
}: {
  tone?: "alarm" | "notice"
  title?: string
  children?: ReactNode
  className?: string
}) {
  const tones = {
    alarm: "border-alarm/35 bg-alarm-deep/30 text-alarm",
    notice: "border-safelight/30 bg-safelight-deep/15 text-safelight",
  }

  return (
    // role="status", not "alert": these render in response to something the
    // guest just did and are already in front of them. "alert" interrupts a
    // screen reader mid-sentence, which is the wrong trade for a message that
    // is not going anywhere.
    <div
      role="status"
      className={`rounded-md border px-3 py-2 text-sm ${tones[tone]} ${className}`}
    >
      {title && <p className="font-medium">{title}</p>}
      {children && (
        <div className={title ? "mt-1 opacity-85" : "opacity-95"}>{children}</div>
      )}
    </div>
  )
}
