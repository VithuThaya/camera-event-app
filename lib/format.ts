/**
 * Display helpers, shared by the host's pages and components.
 *
 * No "server-only" here, on purpose: these run in the browser too, and both
 * sides have to render a number the same way. A storage bar that disagrees with
 * the text beside it is the kind of thing that makes a host distrust the whole
 * dashboard.
 */

const UNITS = ["B", "KB", "MB", "GB"] as const

export function formatBytes(bytes: number): string {
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024
    unit += 1
  }
  // Bytes and kilobytes are never interesting to a fraction of a place.
  const decimals = unit >= 2 && value < 100 ? 1 : 0
  return `${value.toFixed(decimals)} ${UNITS[unit]}`
}

/**
 * Rendered in the reader's own timezone and locale, deliberately.
 *
 * The host set "unlock at 22:00" meaning 22:00 where they are standing. Showing
 * it back in UTC would be technically accurate and completely useless.
 */
export function formatMoment(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  })
}

export function daysUntil(iso: string): number {
  const ms = new Date(iso).getTime() - Date.now()
  return Math.ceil(ms / (1000 * 60 * 60 * 24))
}
