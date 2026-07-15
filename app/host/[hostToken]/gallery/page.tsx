import Link from "next/link"
import { notFound } from "next/navigation"

import { GalleryGrid } from "@/components/gallery/GalleryGrid"
import { findEventByHostToken } from "@/lib/host"

/**
 * The roll.
 *
 * This page checks only that the event exists — it deliberately does not decide
 * whether the media may be shown. That answer belongs to the gallery route, and
 * the grid renders whatever it says. A second unlock check here would be a
 * second rule to keep in step with the first, and the day they disagree is the
 * day one of them is wrong.
 */
export const dynamic = "force-dynamic"

export default async function HostGalleryPage({
  params,
}: {
  params: Promise<{ hostToken: string }>
}) {
  const { hostToken } = await params

  const event = await findEventByHostToken(hostToken)
  if (!event) notFound()

  return (
    <main className="mx-auto max-w-5xl px-4 py-8">
      {/* No actions here. Slideshow and Download live in GalleryGrid, which is
          the thing the route tells whether the roll is open — this page must not
          learn that a second way. See the note at the top of the file. */}
      <div className="mb-6 min-w-0">
        <Link
          href={`/host/${hostToken}`}
          className="text-sm text-ink-faint underline underline-offset-4 transition-colors hover:text-ink-dim"
        >
          Back
        </Link>
        <h1 className="mt-2 truncate text-2xl font-semibold">{event.name}</h1>
      </div>

      <GalleryGrid hostToken={hostToken} />
    </main>
  )
}
