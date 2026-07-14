import { notFound } from "next/navigation"

import { Slideshow } from "@/components/gallery/Slideshow"
import { findEventByHostToken } from "@/lib/host"

/**
 * The show.
 *
 * No chrome, no heading, no nav: this is going on a television. Everything the
 * host needs to steer it is a key press or a tap, and the reveal gate lives in
 * the gallery route the component reads from — not here. See the gallery page
 * for why that check has exactly one home.
 */
export const dynamic = "force-dynamic"

export default async function HostSlideshowPage({
  params,
}: {
  params: Promise<{ hostToken: string }>
}) {
  const { hostToken } = await params

  const event = await findEventByHostToken(hostToken)
  if (!event) notFound()

  return <Slideshow hostToken={hostToken} />
}
