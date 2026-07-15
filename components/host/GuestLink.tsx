"use client"

import QRCode from "qrcode"
import { useEffect, useState } from "react"

import { Panel } from "@/components/ui/Panel"

/**
 * The way in, shown again.
 *
 * The create screen shows this once, at a moment when nobody is at the party
 * yet. The QR that actually matters is the one the host pulls up on their phone
 * an hour in, when a latecomer asks how to join — so it lives here too.
 *
 * Built in the browser rather than on the server because the link is
 * origin-relative: the same event is reached at localhost during a test and at
 * the real domain in production, and the server rendering this page does not
 * reliably know which one the host is looking at.
 */
type Share = { url: string; qr: string | null }

export function GuestLink({ guestToken }: { guestToken: string }) {
  // One piece of state, settled once. The link and its QR are the same fact in
  // two forms, and splitting them would let the component render a moment where
  // it has the link but claims to have no code for it.
  const [share, setShare] = useState<Share | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    let cancelled = false
    const origin = process.env.NEXT_PUBLIC_APP_URL ?? window.location.origin
    const url = `${origin}/e/${guestToken}`

    // A failed QR is not worth an error state: the link below still works, and
    // it is the thing the host actually sends. The code is the convenience.
    QRCode.toDataURL(url, { width: 512, margin: 2 })
      .then((qr) => {
        if (!cancelled) setShare({ url, qr })
      })
      .catch(() => {
        if (!cancelled) setShare({ url, qr: null })
      })

    return () => {
      cancelled = true
    }
  }, [guestToken])

  if (!share) {
    return (
      <Panel>
        <h2 className="font-medium text-ink">Guest link</h2>
      </Panel>
    )
  }

  return (
    <Panel>
      <h2 className="font-medium text-ink">Guest link</h2>
      <p className="mt-1 text-sm text-ink-dim">
        Anyone with this can add shots. No app, no signup.
      </p>

      {share.qr && (
        /* The one white rectangle allowed in the darkroom, and it has to be one.
           A QR is read by a camera that needs real contrast — tinting it to suit
           the room is how you end up with a poster nobody's phone can scan
           across a dim venue.
           eslint-disable-next-line @next/next/no-img-element -- data: URL built
           in-browser; there is nothing for the image optimizer to fetch */
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={share.qr}
          alt="QR code linking guests to this event"
          className="mt-4 w-48 rounded-md bg-white p-2"
        />
      )}

      <div className="mt-3 flex gap-2">
        <input
          readOnly
          value={share.url}
          onFocus={(event) => event.currentTarget.select()}
          className="w-full rounded-md border border-edge bg-ground px-2 py-1 font-mono text-xs text-ink-dim"
        />
        <button
          type="button"
          onClick={async () => {
            await navigator.clipboard.writeText(share.url)
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
          }}
          className="shrink-0 rounded-md border border-edge px-3 py-1 text-xs text-ink transition-colors hover:border-edge-bright"
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </Panel>
  )
}
