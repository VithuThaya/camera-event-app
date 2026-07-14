// archiver 8 is ESM and dropped the archiver("zip", opts) factory that every
// older example uses; it exports classes now and nothing else.
import { ZipArchive } from "archiver"
import { once } from "node:events"
import { Readable } from "node:stream"
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web"
import { NextResponse } from "next/server"

import { type HostMediaItem, gateHostMedia, listConfirmedMedia } from "@/lib/host"
import { extensionForMime } from "@/lib/storagePaths"

/**
 * GET /api/host/[hostToken]/download-all — the whole roll as one ZIP.
 *
 * Streamed, never assembled. The obvious version — download every object, build
 * the archive, send it — needs the entire event resident in memory at once, and
 * an event is allowed up to 20 GiB. This walks the roll one object at a time
 * and pushes bytes out as they arrive, so memory stays flat however big the
 * event gets.
 *
 * Two details carry that:
 *
 *   The next object is not fetched until archiver reports the previous one
 *   written ('entry'). Appending them all up front would open every connection
 *   at once and let archiver's queue grow into exactly the memory this design
 *   exists to avoid.
 *
 *   store: true. JPEG and WebM are already compressed; deflating them again
 *   burns CPU we are billed for to save approximately nothing.
 */

export const runtime = "nodejs"

/**
 * Vercel's ceiling on the Hobby plan, and worth being plain about: this route
 * is bounded by wall-clock, not by memory. A large event over a slow connection
 * will hit this limit and the download will break off mid-file. The gallery's
 * per-item links are the honest fallback; lifting this needs a paid plan or a
 * different delivery path (a pre-built archive in Storage), not a tweak here.
 */
export const maxDuration = 60

/**
 * Names inside the archive: ordered, timestamped, unique by construction.
 *
 * The storage path is a random UUID — deliberately, see lib/storagePaths.ts —
 * which makes for a useless filename. The leading index is what keeps the roll
 * in the order the night happened once it lands in a folder that sorts by name.
 */
function entryName(item: HostMediaItem, index: number): string {
  const ext = extensionForMime(item.mimeType) ?? "bin"
  const stamp = new Date(item.createdAt).toISOString().slice(0, 19).replace(/[:T]/g, "-")
  return `${String(index + 1).padStart(4, "0")}_${stamp}.${ext}`
}

/**
 * A filename that survives the trip through an HTTP header.
 *
 * Event names are free text, and quotes or newlines in one would let the name
 * break out of this header and forge others. Everything outside a conservative
 * allowlist becomes an underscore; the real UTF-8 name rides along in filename*
 * for browsers that can take it.
 */
function contentDisposition(eventName: string): string {
  const ascii = eventName.replace(/[^A-Za-z0-9._ -]/g, "_").trim() || "event"
  const utf8 = encodeURIComponent(`${eventName}.zip`)
  return `attachment; filename="${ascii}.zip"; filename*=UTF-8''${utf8}`
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ hostToken: string }> },
) {
  const { hostToken } = await params

  const gate = await gateHostMedia(hostToken)
  if (!gate.ok) {
    if (gate.reason === "locked") {
      return NextResponse.json(
        { error: "This event is still locked.", code: "locked" },
        { status: 403 },
      )
    }
    return NextResponse.json({ error: "Not found" }, { status: 404 })
  }

  const items = await listConfirmedMedia(gate.event.id)
  if (!items) {
    return NextResponse.json({ error: "Could not read the media." }, { status: 500 })
  }
  if (items.length === 0) {
    // An empty ZIP downloads perfectly well and tells the host nothing.
    return NextResponse.json(
      { error: "Nobody has taken a shot yet.", code: "no_media" },
      { status: 404 },
    )
  }

  const archive = new ZipArchive({ store: true })

  // An error here arrives after the response headers are already on the wire,
  // so there is no status code left to change. Logging and aborting at least
  // ends the stream instead of hanging the host's browser on a download that
  // will never finish — and a truncated ZIP fails its own integrity check, so
  // it cannot be mistaken for a complete backup.
  archive.on("error", (error) => {
    console.error("Archive failed mid-stream:", error)
  })

  void (async () => {
    try {
      for (const [index, item] of items.entries()) {
        const response = await fetch(item.url)
        if (!response.ok || !response.body) {
          throw new Error(`Could not read ${item.id}: HTTP ${response.status}`)
        }

        // Attach before appending: archiver can finish a small entry before the
        // next line runs, and a listener added afterwards would wait forever.
        const entryWritten = once(archive, "entry")
        archive.append(Readable.fromWeb(response.body as NodeWebReadableStream), {
          name: entryName(item, index),
          date: new Date(item.createdAt),
        })
        await entryWritten
      }
      await archive.finalize()
    } catch (error) {
      console.error("Failed while building the archive:", error)
      archive.abort()
    }
  })()

  return new Response(Readable.toWeb(archive) as unknown as ReadableStream, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": contentDisposition(gate.event.name),
      // No Content-Length: the size is unknowable until the last entry is
      // written, and a wrong one is worse than none at all.
      "Cache-Control": "no-store, private",
    },
  })
}
