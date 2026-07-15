import type { ButtonHTMLAttributes } from "react"

/**
 * The one button.
 *
 * Before this there were three hand-rolled copies of
 * `rounded bg-white px-4 py-3 font-medium text-black` — on the landing page, in
 * the consent notice, and in the gallery's locked state — which is how a
 * project ends up with three slightly different buttons nobody meant to design.
 *
 * `variant` is deliberately tiny. A darkroom with five kinds of button is a
 * darkroom where none of them mean anything:
 *
 *   - `primary` is the safelight, and it is the *only* thing on a screen that
 *     glows. One per view — the thing you came to do.
 *   - `quiet` is everything else. It reads as available without asking for
 *     attention.
 *   - `danger` is for the tap that *commits* something irreversible — opening
 *     the roll for good, deleting an event. Not for the button that raises the
 *     confirmation: "Unlock now" only opens a dialog and undoes nothing, so it
 *     stays a primary. Painting the way in red spends the colour before the
 *     moment that needs it, and teaches the host to click through red.
 */

export type ButtonVariant = "primary" | "quiet" | "danger"

/**
 * Exported as a string, not only wrapped in a component, because `next/link`
 * renders its own anchor. A `<Link>` styled to look like a button and a real
 * `<button>` must not be two definitions that drift apart.
 */
export function buttonStyles(variant: ButtonVariant = "primary"): string {
  const base =
    "inline-flex items-center justify-center gap-2 rounded-md px-4 py-3 text-sm font-medium " +
    // 44px is the smallest thing a thumb hits reliably, and the guest flow is
    // entirely thumbs on a phone held at a party.
    "min-h-11 transition-colors duration-150 active:scale-[0.98] " +
    "disabled:pointer-events-none disabled:opacity-40"

  const variants: Record<ButtonVariant, string> = {
    primary: "bg-safelight text-ground hover:bg-safelight/90",
    quiet: "border border-edge text-ink hover:border-edge-bright hover:bg-surface",
    danger: "border border-alarm/40 text-alarm hover:border-alarm hover:bg-alarm-deep/40",
  }

  return `${base} ${variants[variant]}`
}

export function Button({
  variant = "primary",
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) {
  // type defaults to "submit" inside a form, which has surprised every codebase
  // that ever shipped a button. Callers who want a submit say so.
  return (
    <button type="button" className={`${buttonStyles(variant)} ${className}`} {...props} />
  )
}
