/**
 * Phase 4b checkpoint: proves the retention sweep deletes what it must and
 * nothing else.
 *
 * Needs a dev server on NEXT_PUBLIC_APP_URL, the service_role key, and
 * CRON_SECRET — the same one the server was started with:
 *   node --env-file=.env.local scripts/verify-retention.mjs
 *
 * The plan asked for one thing here: "retention sweep test against a manually
 * backdated event". That question is easy to answer dishonestly, which shapes
 * everything below. A sweep that deleted every event on earth would sail
 * through a test that only checks the backdated one is gone — so every deletion
 * check here is paired with a survival check, and the boundary is probed from
 * both sides with the same event.
 *
 * This project has produced six tests that passed while measuring nothing.
 * Nothing here reads "no error" as "passed".
 */

import { createClient } from "@supabase/supabase-js"
import sharp from "sharp"

const APP = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000"
const BUCKET = "event-media"
const CRON_SECRET = process.env.CRON_SECRET

const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
})

let failures = 0
const check = (label, ok, detail) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`)
  if (!ok) failures++
}

const cleanup = []

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
const RETENTION_DAYS = 7

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
      name: "Phase 4 retention verification",
      maxGuests: 5,
      maxUploadsPerGuest: 5,
      maxStorageBytes: 104857600,
      retentionDays: RETENTION_DAYS,
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

async function initUpload(guestToken, cookie, bytes) {
  const init = await fetch(`${APP}/api/events/${guestToken}/upload/init`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ mediaType: "photo", mimeType: "image/jpeg", sizeBytes: bytes.length }),
  })
  if (!init.ok) throw new Error(`init failed: ${init.status}`)
  return init.json()
}

/** A confirmed shot, through the real guest path. */
async function shoot(guestToken, cookie, bytes) {
  const { mediaId, uploadUrl } = await initUpload(guestToken, cookie, bytes)

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
async function abandonAfterUpload(guestToken, cookie, bytes) {
  const { mediaId, uploadUrl } = await initUpload(guestToken, cookie, bytes)
  const put = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "content-type": "image/jpeg" },
    body: bytes,
  })
  if (!put.ok) throw new Error(`put failed: ${put.status}`)
  return mediaId
}

/** A reservation the guest never used: a pending row with no object behind it. */
async function abandonBeforeUpload(guestToken, cookie, bytes) {
  const { mediaId } = await initUpload(guestToken, cookie, bytes)
  return mediaId
}

async function unlockNow(hostToken) {
  const response = await fetch(`${APP}/api/host/${hostToken}/unlock`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode: "now" }),
  })
  if (!response.ok) throw new Error(`unlock failed: ${response.status}`)
  return response.json()
}

async function runCron(auth = `Bearer ${CRON_SECRET}`) {
  const response = await fetch(`${APP}/api/cron/retention`, {
    headers: auth ? { authorization: auth } : {},
  })
  const body = await response.json().catch(() => null)
  return { status: response.status, body }
}

const readEvent = async (id) =>
  (await db.from("events").select("*").eq("id", id).single()).data

const readMedia = async (id) =>
  (await db.from("media_items").select("*").eq("id", id).single()).data

const listFolder = async (eventId) =>
  (await db.storage.from(BUCKET).list(`events/${eventId}`)).data ?? []

const dashboard = async (hostToken) =>
  (await fetch(`${APP}/api/host/${hostToken}`, { cache: "no-store" })).json()

/** Move the reveal back in time so the deadline lands where the test wants it. */
const setUnlockedAt = (eventId, when) =>
  db.from("events").update({ unlocked_at: when.toISOString() }).eq("id", eventId)

const setMediaCreatedAt = (mediaId, when) =>
  db.from("media_items").update({ created_at: when.toISOString() }).eq("id", mediaId)

async function main() {
  if (!CRON_SECRET) {
    console.error("CRON_SECRET is not set. Add it to .env.local and restart the dev server.")
    process.exit(1)
  }

  const bytes = await photo()

  // ---------------------------------------------------------------- auth gate
  console.log("\nThe cron route answers only to the secret")

  const noAuth = await runCron(null)
  check("no Authorization header is refused", noAuth.status === 404, `got ${noAuth.status}`)

  const wrongAuth = await runCron("Bearer not-the-secret")
  check("a wrong secret is refused", wrongAuth.status === 404, `got ${wrongAuth.status}`)

  const rawAuth = await runCron(CRON_SECRET)
  check(
    "the bare secret without 'Bearer ' is refused",
    rawAuth.status === 404,
    `got ${rawAuth.status}`,
  )

  const goodAuth = await runCron()
  check("the real secret is accepted", goodAuth.status === 200, `got ${goodAuth.status}`)
  check(
    "...and the run reports what it did",
    goodAuth.body?.ok === true && typeof goodAuth.body?.eventsArchived === "number",
    JSON.stringify(goodAuth.body),
  )

  // ------------------------------------------------- the boundary, both sides
  console.log("\nThe sweep takes an event exactly when the dashboard says it will")

  const expiring = await createEvent({ name: "Expiring event" })
  const expiringCookie = await join(expiring.guestToken)
  const keptShot = await shoot(expiring.guestToken, expiringCookie, bytes)
  await shoot(expiring.guestToken, expiringCookie, bytes)
  await unlockNow(expiring.hostToken)

  // One hour short of the deadline: unlocked RETENTION_DAYS ago, plus an hour.
  await setUnlockedAt(expiring.eventId, new Date(Date.now() - RETENTION_DAYS * DAY + HOUR))

  const beforeDash = await dashboard(expiring.hostToken)
  const beforeDeadline = new Date(beforeDash.retention.deadline).getTime()
  check(
    "the dashboard puts the deadline just ahead (about an hour)",
    beforeDeadline > Date.now() && beforeDeadline - Date.now() < 2 * HOUR,
    `in ${Math.round((beforeDeadline - Date.now()) / 60000)} min`,
  )

  const earlyRun = await runCron()
  check("the sweep runs", earlyRun.status === 200, `got ${earlyRun.status}`)

  const stillActive = await readEvent(expiring.eventId)
  check(
    "an event an hour short of its deadline is left alone",
    stillActive.status === "active",
    `status=${stillActive.status}`,
  )
  const stillThere = await listFolder(expiring.eventId)
  check("...and its photos are still in the bucket", stillThere.length === 2, `${stillThere.length} objects`)

  // Now an hour past it. Same event, opposite answer.
  await setUnlockedAt(expiring.eventId, new Date(Date.now() - RETENTION_DAYS * DAY - HOUR))

  const afterDash = await dashboard(expiring.hostToken)
  check(
    "the dashboard now puts the deadline in the past",
    new Date(afterDash.retention.deadline).getTime() < Date.now(),
    afterDash.retention.deadline,
  )

  // ------------------------------------------ a live event to prove restraint
  // Created before the sweep runs, so the same pass sees both. If the sweep is
  // indiscriminate, this is what catches it.
  const survivor = await createEvent({ name: "Live event" })
  const survivorCookie = await join(survivor.guestToken)
  await shoot(survivor.guestToken, survivorCookie, bytes)
  await unlockNow(survivor.hostToken)

  // Never unlocked at all: has no deadline and must never expire.
  const sealed = await createEvent({ name: "Sealed forever" })
  const sealedCookie = await join(sealed.guestToken)
  await shoot(sealed.guestToken, sealedCookie, bytes)

  // A reveal that happened by schedule rather than by hand: is_unlocked is
  // still false and the moment lives in unlock_at alone. Phase 3 proved this
  // state opens the gallery, so it must expire like any other — and it is the
  // only thing that exercises the second half of the sweep's pre-filter. Get
  // that expression wrong and every scheduled event keeps its photos forever
  // while the tests stay green.
  const scheduled = await createEvent({ name: "Scheduled reveal" })
  const scheduledCookie = await join(scheduled.guestToken)
  await shoot(scheduled.guestToken, scheduledCookie, bytes)
  await db
    .from("events")
    .update({ unlock_at: new Date(Date.now() - RETENTION_DAYS * DAY - HOUR).toISOString() })
    .eq("id", scheduled.eventId)

  const scheduledBefore = await readEvent(scheduled.eventId)
  check(
    "the scheduled event is genuinely revealed without is_unlocked being set",
    scheduledBefore.is_unlocked === false && scheduledBefore.unlocked_at === null,
    `is_unlocked=${scheduledBefore.is_unlocked}, unlocked_at=${scheduledBefore.unlocked_at}`,
  )

  console.log("\nThe expired event is emptied")

  const sweep = await runCron()
  check("the sweep runs", sweep.status === 200, `got ${sweep.status}`)
  check(
    "...and reports archiving at least this event",
    sweep.body?.eventsArchived >= 1,
    JSON.stringify(sweep.body),
  )
  check("...with no failures", sweep.body?.eventsFailed === 0, JSON.stringify(sweep.body))

  const archived = await readEvent(expiring.eventId)
  check("the expired event is archived", archived.status === "archived", `status=${archived.status}`)
  check(
    "...its storage counter is back to zero",
    Number(archived.storage_used_bytes) === 0,
    `${archived.storage_used_bytes} bytes`,
  )
  const emptied = await listFolder(expiring.eventId)
  check("...the bucket folder is empty", emptied.length === 0, `${emptied.length} objects left`)
  const keptRow = await readMedia(keptShot)
  check("...the media rows are marked deleted", keptRow.status === "deleted", `status=${keptRow.status}`)
  check(
    "...and the host is told the photos are gone rather than shown a 404",
    (await dashboard(expiring.hostToken)).status === "archived",
  )

  const archivedGallery = await fetch(`${APP}/api/host/${expiring.hostToken}/gallery`)
  const archivedItems = (await archivedGallery.json()).items
  check(
    "...the gallery of an archived event is empty, not broken",
    archivedGallery.status === 200 && archivedItems.length === 0,
    `${archivedGallery.status}, ${archivedItems?.length} items`,
  )

  console.log("\nThe same sweep leaves everything else standing")

  const liveEvent = await readEvent(survivor.eventId)
  check(
    "an unlocked event inside its retention window survives",
    liveEvent.status === "active",
    `status=${liveEvent.status}`,
  )
  const liveObjects = await listFolder(survivor.eventId)
  check("...with its photo still in the bucket", liveObjects.length === 1, `${liveObjects.length} objects`)
  check(
    "...and its storage counter untouched",
    Number(liveEvent.storage_used_bytes) > 0,
    `${liveEvent.storage_used_bytes} bytes`,
  )

  const sealedEvent = await readEvent(sealed.eventId)
  check(
    "an event that was never unlocked has no deadline and survives",
    sealedEvent.status === "active",
    `status=${sealedEvent.status}`,
  )
  const sealedObjects = await listFolder(sealed.eventId)
  check("...with its photo still in the bucket", sealedObjects.length === 1, `${sealedObjects.length} objects`)

  console.log("\nA reveal that happened by schedule expires just the same")

  const scheduledEvent = await readEvent(scheduled.eventId)
  check(
    "an expired scheduled reveal is archived too",
    scheduledEvent.status === "archived",
    `status=${scheduledEvent.status}`,
  )
  const scheduledObjects = await listFolder(scheduled.eventId)
  check(
    "...and its bucket folder is empty",
    scheduledObjects.length === 0,
    `${scheduledObjects.length} objects left`,
  )

  // ------------------------------------------------------ abandoned uploads
  console.log("\nAbandoned uploads are cleared without touching kept shots")

  const orphaned = await abandonAfterUpload(survivor.guestToken, survivorCookie, bytes)
  const reserved = await abandonBeforeUpload(survivor.guestToken, survivorCookie, bytes)
  const fresh = await abandonAfterUpload(survivor.guestToken, survivorCookie, bytes)

  const beforePending = await listFolder(survivor.eventId)
  check(
    "the abandoned objects really are sitting in the bucket first",
    beforePending.length === 3,
    `${beforePending.length} objects (kept + orphaned + in-flight)`,
  )

  // Two hours old: past the one-hour threshold. The third stays fresh.
  await setMediaCreatedAt(orphaned, new Date(Date.now() - 2 * HOUR))
  await setMediaCreatedAt(reserved, new Date(Date.now() - 2 * HOUR))

  const pendingSweep = await runCron()
  check("the sweep runs", pendingSweep.status === 200, `got ${pendingSweep.status}`)
  check(
    "...and reports clearing both stale reservations",
    pendingSweep.body?.abandonedCleared === 2,
    JSON.stringify(pendingSweep.body),
  )

  const orphanRow = await readMedia(orphaned)
  check(
    "the abandoned upload's row is cleared",
    orphanRow.status === "deleted",
    `status=${orphanRow.status}`,
  )
  const reservedRow = await readMedia(reserved)
  check(
    "a reservation with no object behind it is cleared without error",
    reservedRow.status === "deleted",
    `status=${reservedRow.status}`,
  )
  const freshRow = await readMedia(fresh)
  check(
    "an upload still in flight is left alone",
    freshRow.status === "pending",
    `status=${freshRow.status}`,
  )

  const afterPending = await listFolder(survivor.eventId)
  check(
    "the orphaned object is gone and the kept shot and in-flight upload remain",
    afterPending.length === 2,
    `${afterPending.length} objects`,
  )

  const survivorDash = await dashboard(survivor.hostToken)
  check(
    "the kept shot is still the only thing the host is shown",
    survivorDash.usage.shotCount === 1,
    `shotCount=${survivorDash.usage.shotCount}`,
  )
}

main()
  .catch((error) => {
    console.error("\nverify-retention crashed:", error)
    failures++
  })
  .finally(async () => {
    for (const id of cleanup) {
      const { data } = await db.storage.from(BUCKET).list(`events/${id}`)
      if (data?.length) {
        await db.storage.from(BUCKET).remove(data.map((o) => `events/${id}/${o.name}`))
      }
      await db.from("events").delete().eq("id", id)
    }
    console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} FAILED.`)
    process.exit(failures === 0 ? 0 : 1)
  })
