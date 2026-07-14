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
      <div className="mb-6 flex items-center justify-between gap-4">
        <div>
          <Link href={`/host/${hostToken}`} className="text-sm text-neutral-400 underline">
            Back
          </Link>
          <h1 className="mt-2 text-2xl font-semibold">{event.name}</h1>
        </div>

        <div className="flex shrink-0 gap-2">
          <Link
            href={`/host/${hostToken}/slideshow`}
            className="rounded border border-neutral-700 px-3 py-2 text-sm"
          >
            Slideshow
          </Link>
          {/* A plain link, not a fetch: the ZIP is streamed and can run to
              gigabytes, so it belongs to the browser's download manager rather
              than to a blob a tab would have to hold in memory first. */}
          <a
            href={`/api/host/${hostToken}/download-all`}
            className="rounded bg-white px-3 py-2 text-sm font-medium text-black"
          >
            Download all
          </a>
        </div>
      </div>

      <GalleryGrid hostToken={hostToken} />
    </main>
  )
}
