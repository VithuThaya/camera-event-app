import type { ReactNode } from "react"

/**
 * A lit surface in a dark room.
 *
 * Panels lift by getting *lighter and warmer*, never by casting a shadow — a
 * drop shadow on a near-black ground is invisible, and every attempt to make it
 * visible ends in a grey halo that reads as a rendering bug. Light is the only
 * depth cue the darkroom has.
 */
export function Panel({
  children,
  className = "",
}: {
  children: ReactNode
  className?: string
}) {
  return (
    <div className={`rounded-lg border border-edge bg-surface/70 p-5 ${className}`}>
      {children}
    </div>
  )
}

/**
 * The label above a heading — "A SHARED CAMERA FOR YOUR EVENT".
 *
 * Mono and letterspaced, like the edge printing on a film strip. It is
 * decoration, so it is a `<p>` and not a heading: putting it in the document
 * outline would give every page a fake extra level above its real title.
 */
export function Eyebrow({ children }: { children: ReactNode }) {
  return (
    <p className="font-mono text-[0.6875rem] uppercase tracking-[0.2em] text-ink-faint">
      {children}
    </p>
  )
}
