/**
 * Phase 3 checkpoint: proves the host side enforces what it claims.
 *
 * Needs a dev server on NEXT_PUBLIC_APP_URL and the service_role key:
 *   node --env-file=.env.local scripts/verify-host.mjs
 *
 * The plan asked two questions of this phase, and they are the spine of what
 * follows: does the gallery genuinely refuse before the unlock when called
 * directly rather than through the UI, and can someone holding a guest token
 * reach anything under /api/host. Everything else here exists because it would
 * be embarrassing to answer those two and still ship a bug.
 *
 * Every check states what it expects and fails loudly otherwise. A check that
 * cannot tell its failure from its success is worse than no check — this
 * project has produced five of those already, so nothing here reads "no error"
 * as "passed".
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

const cleanup = []

const photo = () =>
  sharp({
    create: { width: 40, height: 40, channels: 3, background: { r: 10, g: 90, b: 160 } },
  })
    .jpeg()
    .toBuffer()

async function createEvent(overrides) {
  const response = await fetch(`${APP}/api/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "Phase 3 verification",
      maxGuests: 5,
      maxUploadsPerGuest: 5,
      maxStorageBytes: 104857600,
      retentionDays: 7,
      ...overrides,
    }),
  })
  if (!response.ok) throw new Error(`create event failed: ${response.status}`)
  const event = await response.json()
  cleanup.push(event.eventId)
  return event
}

async function join(guestToken) {
  const response = await fetch(`${APP}/api/events/${guestToken}/consent`, { method: "POST" })
  if (!response.ok) throw new Error(`consent failed: ${response.status}`)
  return response.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ")
}

/** A confirmed shot, through the real guest path. */
async function shoot(guestToken, cookie, bytes) {
  const init = await fetch(`${APP}/api/events/${guestToken}/upload/init`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ mediaType: "photo", mimeType: "image/jpeg", sizeBytes: bytes.length }),
  })
  if (!init.ok) throw new Error(`init failed: ${init.status}`)
  const { mediaId, uploadUrl } = await init.json()

  const put = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "content-type": "image/jpeg" },
    body: bytes,
  })
  if (!put.ok) throw new Error(`put failed: ${put.status}`)

  const confirm = await fetch(`${APP}/api/events/${guestToken}/upload/confirm`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ mediaId }),
  })
  if (!confirm.ok) throw new Error(`confirm failed: ${confirm.status}`)
  return mediaId
}

/** An object in the bucket whose row never reached 'confirmed'. */
async function abandonUpload(guestToken, cookie, bytes) {
  const init = await fetch(`${APP}/api/events/${guestToken}/upload/init`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ mediaType: "photo", mimeType: "image/jpeg", sizeBytes: bytes.length }),
  })
  const { mediaId, uploadUrl, path } = await init.json()
  await fetch(uploadUrl, { method: "PUT", headers: { "content-type": "image/jpeg" }, body: bytes })
  return { mediaId, path }
}

const unlock = (hostToken, body) =>
  fetch(`${APP}/api/host/${hostToken}/unlock`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })

const patchSettings = (hostToken, body) =>
  fetch(`${APP}/api/host/${hostToken}/settings`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "Sealed Event",
      maxGuests: 5,
      maxUploadsPerGuest: 5,
      maxStorageBytes: 104857600,
      retentionDays: 7,
      ...body,
    }),
  })

const readEvent = async (id) =>
  (await db.from("events").select("*").eq("id", id).single()).data

/**
 * Entry names out of a ZIP, read from the archive's own bytes.
 *
 * Deliberately not a zip library: this is proving the route produced a real
 * archive, and asking a parser that shares assumptions with the writer to grade
 * the writer is how you get a green test over a broken file.
 */
function zipEntryNames(buf) {
  const names = []
  for (let i = 0; i < buf.length - 30; i++) {
    // Local file header signature: PK\x03\x04
    if (buf[i] === 0x50 && buf[i + 1] === 0x4b && buf[i + 2] === 0x03 && buf[i + 3] === 0x04) {
      const nameLength = buf.readUInt16LE(i + 26)
      names.push(buf.subarray(i + 30, i + 30 + nameLength).toString("utf8"))
    }
  }
  return names
}

/** A truncated stream has entries but no end record. This is what tells them apart. */
function hasEndOfCentralDirectory(buf) {
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf[i] === 0x50 && buf[i + 1] === 0x4b && buf[i + 2] === 0x05 && buf[i + 3] === 0x06) {
      return true
    }
  }
  return false
}

// =============================================================================
try {
  const jpeg = await photo()

  // ---------------------------------------------------------------------------
  console.log("\nsetup: a sealed event with two shots in it")
  const a = await createEvent({ name: "Sealed Event" })
  const aCookie = await join(a.guestToken)
  await shoot(a.guestToken, aCookie, jpeg)
  await shoot(a.guestToken, aCookie, jpeg)

  const dash = await fetch(`${APP}/api/host/${a.hostToken}`)
  const dashBody = await dash.json()
  check("dashboard returns 200", dash.status === 200, `got ${dash.status}`)
  check("dashboard counts both shots", dashBody.usage.shotCount === 2, `got ${dashBody.usage.shotCount}`)
  check("dashboard counts the guest", dashBody.usage.guestCount === 1, `got ${dashBody.usage.guestCount}`)
  check("dashboard reports NOT revealed", dashBody.unlock.revealed === false)
  check("dashboard never echoes the host token", !JSON.stringify(dashBody).includes(a.hostToken))
  check("dashboard has no retention deadline while sealed", dashBody.retention.deadline === null)

  // ---------------------------------------------------------------------------
  console.log("\nthe plan's first question: does the seal hold against a direct call")
  const lockedGallery = await fetch(`${APP}/api/host/${a.hostToken}/gallery`)
  const lockedGalleryBody = await lockedGallery.json()
  check("gallery before unlock is REFUSED with 403", lockedGallery.status === 403, `got ${lockedGallery.status}`)
  check("gallery refusal names the reason", lockedGalleryBody.code === "locked", JSON.stringify(lockedGalleryBody))
  check("gallery refusal carries no signed URL", !JSON.stringify(lockedGalleryBody).includes("token="))

  const lockedZip = await fetch(`${APP}/api/host/${a.hostToken}/download-all`)
  check("download-all before unlock is REFUSED with 403", lockedZip.status === 403, `got ${lockedZip.status}`)
  check("...and is not a zip", !(lockedZip.headers.get("content-type") ?? "").includes("zip"))

  // ---------------------------------------------------------------------------
  console.log("\nthe plan's second question: can a guest token reach the host side")
  const b = await createEvent({ name: "Other Event" })

  for (const [label, path] of [
    ["dashboard", ""],
    ["gallery", "/gallery"],
    ["download-all", "/download-all"],
  ]) {
    const asGuest = await fetch(`${APP}/api/host/${a.guestToken}${path}`)
    check(`${label} with a GUEST token returns 404`, asGuest.status === 404, `got ${asGuest.status}`)
  }

  const withGuestCookie = await fetch(`${APP}/api/host/${a.guestToken}/gallery`, {
    headers: { cookie: aCookie },
  })
  check("gallery with a guest token AND that guest's cookie returns 404", withGuestCookie.status === 404, `got ${withGuestCookie.status}`)

  const hostTokenAtGuestRoute = await fetch(`${APP}/api/events/${a.hostToken}`)
  check("host token at a GUEST route returns 404", hostTokenAtGuestRoute.status === 404, `got ${hostTokenAtGuestRoute.status}`)

  const unlockAsGuest = await unlock(a.guestToken, { mode: "now" })
  check("unlock with a guest token returns 404", unlockAsGuest.status === 404, `got ${unlockAsGuest.status}`)
  check("...and the event is still sealed", (await readEvent(a.eventId)).is_unlocked === false)

  for (const bogus of ["short", "x".repeat(43), `${a.hostToken}x`]) {
    const response = await fetch(`${APP}/api/host/${encodeURIComponent(bogus)}/gallery`)
    check(`a bogus host token (${bogus.slice(0, 10)}…) returns 404`, response.status === 404, `got ${response.status}`)
  }

  // ---------------------------------------------------------------------------
  console.log("\nunlock: the schedule")
  const past = await unlock(a.hostToken, {
    mode: "schedule",
    unlockAt: new Date(Date.now() - 60_000).toISOString(),
  })
  check("scheduling in the PAST is rejected (400)", past.status === 400, `got ${past.status}`)
  check("...and did not unlock the event", (await readEvent(a.eventId)).is_unlocked === false)

  const future = new Date(Date.now() + 3_600_000).toISOString()
  const scheduled = await unlock(a.hostToken, { mode: "schedule", unlockAt: future })
  check("scheduling in the future returns 200", scheduled.status === 200, `got ${scheduled.status}`)
  check("...and records unlock_at", (await readEvent(a.eventId)).unlock_at !== null)
  check("...but reveals nothing yet", (await readEvent(a.eventId)).is_unlocked === false)

  const stillLockedGallery = await fetch(`${APP}/api/host/${a.hostToken}/gallery`)
  check("gallery with a future schedule is still 403", stillLockedGallery.status === 403, `got ${stillLockedGallery.status}`)

  const cancelled = await unlock(a.hostToken, { mode: "cancel" })
  check("cancelling the schedule returns 200", cancelled.status === 200, `got ${cancelled.status}`)
  check("...and clears unlock_at", (await readEvent(a.eventId)).unlock_at === null)

  // ---------------------------------------------------------------------------
  console.log("\nunlock: the moment itself, which must be stamped exactly once")
  const opened = await unlock(a.hostToken, { mode: "now" })
  check("unlock now returns 200", opened.status === 200, `got ${opened.status}`)

  const afterUnlock = await readEvent(a.eventId)
  check("is_unlocked is true", afterUnlock.is_unlocked === true)
  check("unlocked_at is stamped", afterUnlock.unlocked_at !== null)
  const firstStamp = afterUnlock.unlocked_at

  await new Promise((resolve) => setTimeout(resolve, 1100))
  const replayed = await unlock(a.hostToken, { mode: "now" })
  const replayedBody = await replayed.json()
  check("a second unlock returns 200 (idempotent)", replayed.status === 200, `got ${replayed.status}`)
  check("...and says so", replayedBody.alreadyUnlocked === true, JSON.stringify(replayedBody))
  const secondStamp = (await readEvent(a.eventId)).unlocked_at
  check(
    "...and did NOT move unlocked_at, which is the retention clock",
    secondStamp === firstStamp,
    `${firstStamp} -> ${secondStamp}`,
  )

  const relock = await unlock(a.hostToken, { mode: "schedule", unlockAt: future })
  check("re-scheduling a revealed event is REFUSED (409)", relock.status === 409, `got ${relock.status}`)
  check("...and it stays revealed", (await readEvent(a.eventId)).is_unlocked === true)

  const recancel = await unlock(a.hostToken, { mode: "cancel" })
  check("cancelling on a revealed event is REFUSED (409)", recancel.status === 409, `got ${recancel.status}`)

  const racers = await Promise.all([
    unlock(b.hostToken, { mode: "now" }),
    unlock(b.hostToken, { mode: "now" }),
    unlock(b.hostToken, { mode: "now" }),
  ])
  check("three simultaneous unlocks all return 200", racers.every((r) => r.status === 200))
  const bRow = await readEvent(b.eventId)
  check("...and the raced event ends up unlocked exactly once", bRow.is_unlocked === true && bRow.unlocked_at !== null)

  // ---------------------------------------------------------------------------
  console.log("\nthe roll, once it is open")
  const abandoned = await abandonUpload(a.guestToken, aCookie, jpeg)

  const gallery = await fetch(`${APP}/api/host/${a.hostToken}/gallery`)
  const galleryBody = await gallery.json()
  check("gallery after unlock returns 200", gallery.status === 200, `got ${gallery.status}`)
  check("gallery returns exactly the two confirmed shots", galleryBody.items.length === 2, `got ${galleryBody.items.length}`)
  check("gallery excludes the abandoned upload", !galleryBody.items.some((i) => i.id === abandoned.mediaId))
  check("gallery is ordered oldest first", galleryBody.items[0].createdAt <= galleryBody.items[1].createdAt)
  check("gallery says when its URLs die", galleryBody.expiresInSeconds > 0, `${galleryBody.expiresInSeconds}`)
  check("gallery response is not cacheable", (gallery.headers.get("cache-control") ?? "").includes("no-store"), gallery.headers.get("cache-control"))

  const firstItem = await fetch(galleryBody.items[0].url)
  const firstBytes = Buffer.from(await firstItem.arrayBuffer())
  check("a gallery URL actually resolves", firstItem.status === 200, `got ${firstItem.status}`)
  check("...to the bytes the row records", firstBytes.length === galleryBody.items[0].sizeBytes, `${firstBytes.length} vs ${galleryBody.items[0].sizeBytes}`)

  const otherGallery = await fetch(`${APP}/api/host/${b.hostToken}/gallery`)
  const otherBody = await otherGallery.json()
  check("another event's host token shows none of this event's shots", otherBody.items.length === 0, `got ${otherBody.items.length}`)

  // ---------------------------------------------------------------------------
  console.log("\ndownload-all")
  const zip = await fetch(`${APP}/api/host/${a.hostToken}/download-all`)
  const zipBytes = Buffer.from(await zip.arrayBuffer())
  check("download-all after unlock returns 200", zip.status === 200, `got ${zip.status}`)
  check("...as a zip", (zip.headers.get("content-type") ?? "").includes("application/zip"), zip.headers.get("content-type"))
  check("...named after the event", (zip.headers.get("content-disposition") ?? "").includes("Sealed Event.zip"), zip.headers.get("content-disposition"))
  check("...and is a complete archive, not a truncated stream", hasEndOfCentralDirectory(zipBytes), `${zipBytes.length} bytes`)

  const names = zipEntryNames(zipBytes)
  check("zip holds exactly the two confirmed shots", names.length === 2, JSON.stringify(names))
  check(
    "zip entries are ordered and named .jpg",
    names.every((n, i) => n.startsWith(String(i + 1).padStart(4, "0")) && n.endsWith(".jpg")),
    JSON.stringify(names),
  )
  check("zip is not cacheable", (zip.headers.get("cache-control") ?? "").includes("no-store"))

  const emptyZip = await fetch(`${APP}/api/host/${b.hostToken}/download-all`)
  const emptyBody = await emptyZip.json()
  check("download-all on an empty event returns 404, not an empty zip", emptyZip.status === 404, `got ${emptyZip.status}`)
  check("...and says why", emptyBody.code === "no_media", JSON.stringify(emptyBody))

  // ---------------------------------------------------------------------------
  console.log("\na scheduled reveal that has come due opens the gate by itself")
  const c = await createEvent({ name: "Scheduled Event" })
  const cCookie = await join(c.guestToken)
  await shoot(c.guestToken, cCookie, jpeg)

  const cLocked = await fetch(`${APP}/api/host/${c.hostToken}/gallery`)
  check("still 403 before its moment", cLocked.status === 403, `got ${cLocked.status}`)

  // Backdated directly: the create route refuses a past unlock_at, which is
  // correct, and is exactly why this cannot be set up through the API.
  await db
    .from("events")
    .update({ unlock_at: new Date(Date.now() - 60_000).toISOString() })
    .eq("id", c.eventId)

  const cOpen = await fetch(`${APP}/api/host/${c.hostToken}/gallery`)
  check("gallery opens once unlock_at has passed", cOpen.status === 200, `got ${cOpen.status}`)
  check("...with is_unlocked still false", (await readEvent(c.eventId)).is_unlocked === false)

  const cDash = await fetch(`${APP}/api/host/${c.hostToken}`)
  const cDashBody = await cDash.json()
  check("dashboard agrees the event is revealed", cDashBody.unlock.revealed === true)
  check("...and now has a retention deadline", cDashBody.retention.deadline !== null)

  const cNow = await unlock(c.hostToken, { mode: "now" })
  check("unlock now on an already-due event is idempotent", (await cNow.json()).alreadyUnlocked === true)
  check("...and does not restamp the clock to now", (await readEvent(c.eventId)).unlocked_at === null)

  // ---------------------------------------------------------------------------
  console.log("\nsettings")
  const used = Number((await readEvent(a.eventId)).storage_used_bytes)
  check("the event has really stored something to compare against", used > 0, `${used} bytes`)

  const ok = await patchSettings(a.hostToken, { retentionDays: 14 })
  check("a valid settings PATCH returns 200", ok.status === 200, `got ${ok.status}`)
  check("...and takes effect", (await readEvent(a.eventId)).retention_days === 14)

  const belowUsed = await patchSettings(a.hostToken, { maxStorageBytes: 104857600, retentionDays: 14 })
  check("a cap above what is used is accepted", belowUsed.status === 200, `got ${belowUsed.status}`)

  const bogusLimit = await patchSettings(a.hostToken, { maxGuests: 0 })
  check("an out-of-range limit is refused (400)", bogusLimit.status === 400, `got ${bogusLimit.status}`)

  /**
   * Reaching the storage guard at all needs an event holding more than the
   * schema's own floor (100 MiB) allows a cap to be set to. Below that floor
   * zod rejects the request first, and the resulting 400 says nothing about
   * this guard.
   *
   * The first version of this check did exactly that: it asked for a cap of
   * used-minus-one, got a 400 from the schema, and reported the guard working.
   * It was green and it was measuring nothing. Backdating the counter is the
   * only way to put the request where the guard is the thing that answers it.
   */
  const MIB_200 = 200 * 1024 * 1024
  await db.from("events").update({ storage_used_bytes: MIB_200 }).eq("id", a.eventId)

  const belowStored = await patchSettings(a.hostToken, { maxStorageBytes: 104857600, retentionDays: 14 })
  const belowStoredBody = await belowStored.json()
  check("a cap below what is ALREADY STORED is refused (400)", belowStored.status === 400, `got ${belowStored.status}`)
  check(
    "...by the storage guard, not by the schema",
    belowStoredBody.code === "below_storage_used",
    JSON.stringify(belowStoredBody),
  )
  check(
    "...and it reports what is actually used",
    belowStoredBody.storageUsedBytes === MIB_200,
    `${belowStoredBody.storageUsedBytes} vs ${MIB_200}`,
  )
  check("...and the cap was not changed", Number((await readEvent(a.eventId)).max_storage_bytes) === 104857600)

  // Put the counter back: the delete checks below read it as the truth.
  await db.from("events").update({ storage_used_bytes: used }).eq("id", a.eventId)

  const tamper = await patchSettings(a.hostToken, {
    retentionDays: 14,
    guest_token: "hijacked",
    host_token: "hijacked",
    storage_used_bytes: 0,
    is_unlocked: false,
    unlocked_at: null,
  })
  check("settings ignores keys it does not own", tamper.status === 200, `got ${tamper.status}`)
  const tampered = await readEvent(a.eventId)
  check("...guest_token unchanged", tampered.guest_token === a.guestToken)
  check("...host_token unchanged", tampered.host_token === a.hostToken)
  check("...storage_used_bytes unchanged", Number(tampered.storage_used_bytes) === used, `${tampered.storage_used_bytes} vs ${used}`)
  check("...and the event was not re-locked through the settings route", tampered.is_unlocked === true)

  const settingsAsGuest = await patchSettings(a.guestToken, {})
  check("settings with a guest token returns 404", settingsAsGuest.status === 404, `got ${settingsAsGuest.status}`)

  // ---------------------------------------------------------------------------
  console.log("\ndelete")
  const wrongName = await fetch(`${APP}/api/host/${a.hostToken}`, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ confirmName: "Not The Name" }),
  })
  const wrongNameBody = await wrongName.json()
  check("delete with the wrong name is REFUSED (400)", wrongName.status === 400, `got ${wrongName.status}`)
  check("...and names the reason", wrongNameBody.code === "name_mismatch", JSON.stringify(wrongNameBody))
  check("...and the event survives", (await readEvent(a.eventId)).deleted_at === null)

  const deleteAsGuest = await fetch(`${APP}/api/host/${a.guestToken}`, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ confirmName: "Sealed Event" }),
  })
  check("delete with a guest token returns 404", deleteAsGuest.status === 404, `got ${deleteAsGuest.status}`)
  check("...and the event still survives", (await readEvent(a.eventId)).deleted_at === null)

  // The claim under test: the purge works from the bucket listing, so it takes
  // the abandoned object too — the one whose row never reached 'confirmed', and
  // whose bytes were therefore never stripped of their metadata.
  const beforeList = await db.storage.from(BUCKET).list(`events/${a.eventId}`)
  check("the bucket holds 3 objects: 2 kept shots and 1 abandoned", beforeList.data.length === 3, `${beforeList.data.length}`)

  const deleted = await fetch(`${APP}/api/host/${a.hostToken}`, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ confirmName: "Sealed Event" }),
  })
  const deletedBody = await deleted.json()
  check("delete with the right name returns 200", deleted.status === 200, `got ${deleted.status}`)
  check("...and reports removing all 3 objects", deletedBody.removed === 3, JSON.stringify(deletedBody))

  const afterList = await db.storage.from(BUCKET).list(`events/${a.eventId}`)
  check("the bucket folder is empty", (afterList.data ?? []).length === 0, `${(afterList.data ?? []).length} left`)

  const signedGone = await db.storage.from(BUCKET).createSignedUrl(abandoned.path, 60)
  const abandonedFetch = signedGone.data
    ? await fetch(signedGone.data.signedUrl, { cache: "no-store" })
    : { status: 404 }
  check(
    "the abandoned, never-stripped object is really gone",
    abandonedFetch.status === 400 || abandonedFetch.status === 404,
    `got ${abandonedFetch.status}`,
  )

  const deletedRow = await readEvent(a.eventId)
  check("event is marked deleted", deletedRow.status === "deleted" && deletedRow.deleted_at !== null)

  const hostAfterDelete = await fetch(`${APP}/api/host/${a.hostToken}`)
  check("the host link stops working", hostAfterDelete.status === 404, `got ${hostAfterDelete.status}`)

  const guestAfterDelete = await fetch(`${APP}/api/events/${a.guestToken}`)
  check("the guest link stops working", guestAfterDelete.status === 404, `got ${guestAfterDelete.status}`)

  const uploadAfterDelete = await fetch(`${APP}/api/events/${a.guestToken}/upload/init`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: aCookie },
    body: JSON.stringify({ mediaType: "photo", mimeType: "image/jpeg", sizeBytes: jpeg.length }),
  })
  check("a guest mid-shoot can no longer upload", uploadAfterDelete.status === 404, `got ${uploadAfterDelete.status}`)
} finally {
  console.log("\ncleanup")
  for (const eventId of cleanup) {
    const list = await db.storage.from(BUCKET).list(`events/${eventId}`)
    if (list.data?.length) {
      await db.storage.from(BUCKET).remove(list.data.map((o) => `events/${eventId}/${o.name}`))
    }
    await db.from("events").delete().eq("id", eventId)
  }
  console.log(`  removed ${cleanup.length} test events`)
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASS" : `${failures} CHECK(S) FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
