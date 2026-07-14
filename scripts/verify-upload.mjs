/**
 * Phase 2 checkpoint: proves the upload path enforces what it claims.
 *
 * Needs a dev server on NEXT_PUBLIC_APP_URL and the service_role key:
 *   node --env-file=.env.local scripts/verify-upload.mjs
 *
 * Every check states what it expects and fails loudly otherwise. A check that
 * cannot tell its failure from its success is worse than no check — this
 * project has produced five of those already, so nothing here treats "no
 * error" as "passed".
 */

import { createClient } from "@supabase/supabase-js"
import sharp from "sharp"

const APP = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000"
const BUCKET = "event-media"

const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
})

let failures = 0
const check = (label, ok, detail) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`)
  if (!ok) failures++
}

/** Independent of sharp: walks JPEG markers looking for an Exif APP1 segment. */
function hasExifSegment(buf) {
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return false
  let i = 2
  while (i < buf.length - 1) {
    if (buf[i] !== 0xff) break
    const marker = buf[i + 1]
    if (marker === 0xda) break
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2
      continue
    }
    const len = buf.readUInt16BE(i + 2)
    if (marker === 0xe1 && buf.subarray(i + 4, i + 8).toString("latin1") === "Exif") return true
    i += 2 + len
  }
  return false
}

const photoWithGps = () =>
  sharp({ create: { width: 600, height: 400, channels: 3, background: "#6b4f3a" } })
    .withMetadata({
      exif: {
        IFD0: { Make: "PartyPhone", Copyright: "guest-real-name" },
        GPS: { GPSLatitudeRef: "N", GPSLatitude: "47.3769", GPSLongitudeRef: "E", GPSLongitude: "8.5417" },
      },
    })
    .jpeg()
    .toBuffer()

const cleanup = []

async function createEvent(overrides) {
  const response = await fetch(`${APP}/api/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "Phase 2 verification",
      maxGuests: 5,
      maxUploadsPerGuest: 2,
      maxStorageBytes: 104857600,
      retentionDays: 1,
      ...overrides,
    }),
  })
  if (!response.ok) throw new Error(`create event failed: ${response.status} ${await response.text()}`)
  const event = await response.json()
  cleanup.push(event.eventId)
  return event
}

async function join(guestToken) {
  const response = await fetch(`${APP}/api/events/${guestToken}/consent`, { method: "POST" })
  if (!response.ok) throw new Error(`consent failed: ${response.status} ${await response.text()}`)
  const cookie = response.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ")
  if (!cookie) throw new Error("consent returned no session cookie")
  return cookie
}

const post = (url, cookie, body) =>
  fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(body),
  })

async function initUpload(guestToken, cookie, bytes) {
  return post(`${APP}/api/events/${guestToken}/upload/init`, cookie, {
    mediaType: "photo",
    mimeType: "image/jpeg",
    sizeBytes: bytes.length,
  })
}

const put = (url, bytes) =>
  fetch(url, { method: "PUT", headers: { "content-type": "image/jpeg" }, body: bytes })

/**
 * Reads a stored object the way the host will actually receive it: through a
 * signed URL, which is the only read path this app ever hands out.
 *
 * Explicitly NOT storage.download(). That endpoint is cached, and confirm
 * fetches the un-stripped original through it in order to strip it — so a
 * download() here is served those cached pre-strip bytes and reports a
 * metadata leak that does not exist. An earlier version of this script did
 * exactly that and produced six confident, wrong failures.
 */
async function readAsHost(path) {
  const { data, error } = await db.storage.from(BUCKET).createSignedUrl(path, 60)
  if (error) throw new Error(`could not sign ${path}: ${error.message}`)
  const response = await fetch(data.signedUrl, { cache: "no-store" })
  if (!response.ok) throw new Error(`signed URL fetch failed: ${response.status}`)
  return Buffer.from(await response.arrayBuffer())
}

// =============================================================================
try {
  const jpeg = await photoWithGps()

  console.log("fixture")
  check("test photo carries an Exif segment", hasExifSegment(jpeg), "else the EXIF check below is vacuous")

  // --- Happy path -----------------------------------------------------------
  console.log("\nhappy path")
  const event = await createEvent()
  const cookie = await join(event.guestToken)

  const initResponse = await initUpload(event.guestToken, cookie, jpeg)
  check("init returns 200", initResponse.status === 200, `got ${initResponse.status}`)
  const { mediaId, path, uploadUrl } = await initResponse.json()

  const putResponse = await put(uploadUrl, jpeg)
  check("signed URL accepts the PUT", putResponse.ok, `got ${putResponse.status}`)

  const confirmResponse = await post(`${APP}/api/events/${event.guestToken}/upload/confirm`, cookie, { mediaId })
  const confirmBody = await confirmResponse.json()
  check("confirm returns 200", confirmResponse.status === 200, `got ${confirmResponse.status}`)
  check("confirm reports exifStripped", confirmBody.exifStripped === true, JSON.stringify(confirmBody))

  // --- The stored object, as the host would receive it -----------------------
  console.log("\nstored object (read through a signed URL, exactly as the host will)")
  const storedBytes = await readAsHost(path)
  check("object exists in the bucket", storedBytes.length > 0, `${storedBytes.length} bytes`)
  check("stored object has NO Exif segment", !hasExifSegment(storedBytes))
  check("stored object has no GPS-bearing Exif header", !storedBytes.includes(Buffer.from("Exif\0\0", "latin1")))
  check("stored object leaks no camera make", !storedBytes.includes(Buffer.from("PartyPhone", "latin1")))
  check("stored object leaks no copyright name", !storedBytes.includes(Buffer.from("guest-real-name", "latin1")))

  const { data: row } = await db.from("media_items").select("*").eq("id", mediaId).single()
  check("row is confirmed", row.status === "confirmed", row.status)
  check("row records exif_stripped=true", row.exif_stripped === true)
  check("row size matches the stored object", Number(row.size_bytes) === storedBytes.length, `${row.size_bytes} vs ${storedBytes.length}`)

  const { data: ev } = await db.from("events").select("storage_used_bytes").eq("id", event.eventId).single()
  check("event storage_used_bytes advanced by exactly the stored size", Number(ev.storage_used_bytes) === storedBytes.length, `${ev.storage_used_bytes} vs ${storedBytes.length}`)

  // --- Replaying confirm must not buy a second slot -------------------------
  console.log("\nconfirm replay")
  const replay = await post(`${APP}/api/events/${event.guestToken}/upload/confirm`, cookie, { mediaId })
  check("replayed confirm returns 200 (idempotent)", replay.status === 200, `got ${replay.status}`)
  const { data: afterReplay } = await db.from("guest_sessions").select("upload_count").eq("event_id", event.eventId).single()
  check("replay did NOT increment upload_count twice", afterReplay.upload_count === 1, `count=${afterReplay.upload_count}`)

  // --- Per-guest cap --------------------------------------------------------
  console.log("\nper-guest cap (limit is 2)")
  const second = await initUpload(event.guestToken, cookie, jpeg)
  check("2nd init allowed", second.status === 200, `got ${second.status}`)
  const secondBody = await second.json()
  await put(secondBody.uploadUrl, jpeg)
  const secondConfirm = await post(`${APP}/api/events/${event.guestToken}/upload/confirm`, cookie, { mediaId: secondBody.mediaId })
  check("2nd confirm allowed", secondConfirm.status === 200, `got ${secondConfirm.status}`)

  const third = await initUpload(event.guestToken, cookie, jpeg)
  const thirdBody = await third.json()
  check("3rd init REJECTED with 403", third.status === 403, `got ${third.status}`)
  check("3rd init names the reason", thirdBody.code === "upload_quota_exceeded", JSON.stringify(thirdBody))

  // --- Storage cap ----------------------------------------------------------
  console.log("\nstorage cap")
  const capEvent = await createEvent({ maxUploadsPerGuest: 5 })
  const capCookie = await join(capEvent.guestToken)
  // Park the event one byte short of full. Uploading 100 MB to prove this would
  // test the same branch far more slowly.
  await db.from("events").update({ storage_used_bytes: 104857600 - 1 }).eq("id", capEvent.eventId)
  const capInit = await initUpload(capEvent.guestToken, capCookie, jpeg)
  const capBody = await capInit.json()
  await put(capBody.uploadUrl, jpeg)
  const capConfirm = await post(`${APP}/api/events/${capEvent.guestToken}/upload/confirm`, capCookie, { mediaId: capBody.mediaId })
  const capConfirmBody = await capConfirm.json()
  check("confirm past the storage cap REJECTED with 403", capConfirm.status === 403, `got ${capConfirm.status}`)
  check("rejection names the reason", capConfirmBody.code === "storage_quota_exceeded", JSON.stringify(capConfirmBody))
  const { data: capRow } = await db.from("media_items").select("status").eq("id", capBody.mediaId).single()
  check("rejected item stays unconfirmed", capRow.status === "pending", capRow.status)
  const { data: capEv } = await db.from("events").select("storage_used_bytes").eq("id", capEvent.eventId).single()
  check("counter did not move on rejection", Number(capEv.storage_used_bytes) === 104857600 - 1, `${capEv.storage_used_bytes}`)

  // --- Confirm without uploading -------------------------------------------
  console.log("\nconfirm with nothing uploaded")
  const ghostEvent = await createEvent()
  const ghostCookie = await join(ghostEvent.guestToken)
  const ghostInit = await initUpload(ghostEvent.guestToken, ghostCookie, jpeg)
  const ghostBody = await ghostInit.json()
  const ghostConfirm = await post(`${APP}/api/events/${ghostEvent.guestToken}/upload/confirm`, ghostCookie, { mediaId: ghostBody.mediaId })
  const ghostConfirmBody = await ghostConfirm.json()
  check("confirm without an object REJECTED with 400", ghostConfirm.status === 400, `got ${ghostConfirm.status}`)
  check("rejection names the reason", ghostConfirmBody.code === "object_missing", JSON.stringify(ghostConfirmBody))

  // --- Cross-event / cross-guest -------------------------------------------
  console.log("\ncross-guest isolation")
  const otherEvent = await createEvent()
  const otherCookie = await join(otherEvent.guestToken)
  const stealAttempt = await post(`${APP}/api/events/${otherEvent.guestToken}/upload/confirm`, otherCookie, { mediaId })
  check("confirming another guest's mediaId returns 404", stealAttempt.status === 404, `got ${stealAttempt.status}`)

  const noCookie = await post(`${APP}/api/events/${event.guestToken}/upload/init`, "", { mediaType: "photo", mimeType: "image/jpeg", sizeBytes: jpeg.length })
  check("init without a session cookie returns 404", noCookie.status === 404, `got ${noCookie.status}`)

  const wrongEventCookie = await post(`${APP}/api/events/${event.guestToken}/upload/init`, otherCookie, { mediaType: "photo", mimeType: "image/jpeg", sizeBytes: jpeg.length })
  check("init with another event's cookie returns 404", wrongEventCookie.status === 404, `got ${wrongEventCookie.status}`)

  // --- Signed upload URL is single-use -------------------------------------
  console.log("\nsigned URL reuse")
  const reuse = await put(uploadUrl, jpeg)
  check("reusing a spent signed upload URL is refused", !reuse.ok, `got ${reuse.status}`)

  // --- Validation ----------------------------------------------------------
  console.log("\nvalidation")
  const badMime = await post(`${APP}/api/events/${ghostEvent.guestToken}/upload/init`, ghostCookie, { mediaType: "photo", mimeType: "image/svg+xml", sizeBytes: 100 })
  check("SVG masquerading as a photo is rejected (400)", badMime.status === 400, `got ${badMime.status}`)

  const longVideo = await post(`${APP}/api/events/${ghostEvent.guestToken}/upload/init`, ghostCookie, { mediaType: "video", mimeType: "video/webm", sizeBytes: 100, durationSeconds: 60 })
  check("a 60s video is rejected (400)", longVideo.status === 400, `got ${longVideo.status}`)

  const hugePhoto = await post(`${APP}/api/events/${ghostEvent.guestToken}/upload/init`, ghostCookie, { mediaType: "photo", mimeType: "image/jpeg", sizeBytes: 99_000_000 })
  check("an oversized photo is rejected (400)", hugePhoto.status === 400, `got ${hugePhoto.status}`)
} finally {
  console.log("\ncleanup")
  for (const eventId of cleanup) {
    const { data: items } = await db.from("media_items").select("storage_path").eq("event_id", eventId)
    if (items?.length) await db.storage.from(BUCKET).remove(items.map((i) => i.storage_path))
    await db.from("events").delete().eq("id", eventId)
  }
  console.log(`  removed ${cleanup.length} test event(s)`)
}

console.log(`\n${failures === 0 ? "All checks passed." : `${failures} check(s) FAILED.`}`)
process.exit(failures === 0 ? 0 : 1)
