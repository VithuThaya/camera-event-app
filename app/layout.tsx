import type { Metadata, Viewport } from "next"
import { Geist, Geist_Mono } from "next/font/google"

import "./globals.css"

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
})

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
})

export const metadata: Metadata = {
  title: "Shared camera for your event",
  description:
    "One QR code, a few shots each, nothing visible until the host unlocks it.",
}

/**
 * `colorScheme` is not decoration. It is what makes the browser's own furniture
 * — scrollbars, the number inputs on the create form, autofill — render dark.
 * Without it a bright white scrollbar runs down the side of the darkroom, and a
 * tapped input flashes a light overlay over the camera.
 *
 * `themeColor` paints the phone's browser chrome the colour of the room, so a
 * guest holding the capture screen sees one continuous surface rather than the
 * app in a light frame. It is matched to --color-ground by hand: this becomes a
 * `<meta>` tag, which cannot read a CSS variable. If the room ever changes
 * shade, this changes with it.
 */
export const viewport: Viewport = {
  colorScheme: "dark",
  themeColor: "#0a0908",
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  // Committed to dark, and the commitment lives in globals.css rather than in
  // utility classes here — the background carries the grain and the safelight
  // glow, which no `bg-*` class can express.
  // Chrome on iOS stamps its own `__gcrremoteframetoken` onto this tag through
  // the __gCrWeb bridge before React ever runs, and guests arrive by scanning a
  // QR with whatever browser their phone opens. The attribute is the browser's,
  // not ours, so there is nothing to reconcile — only a warning to stop. This
  // suppression reaches one level: mismatches inside the app still report.
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col">{children}</body>
    </html>
  )
}
