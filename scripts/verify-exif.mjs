/**
 * Proves lib/exif.ts actually removes metadata.
 *
 *   node --conditions=react-server --experimental-strip-types scripts/verify-exif.mjs
 *
 * The react-server condition makes the "server-only" import resolve to a stub;
 * without it Node refuses the module outright.
 *
 * This deliberately does NOT use sharp to inspect the result. Asking sharp
 * whether sharp stripped the metadata only proves it is self-consistent — the
 * same trap that made three earlier checks in this project report green while
 * testing nothing. It walks the JPEG segment markers by hand and greps the raw
 * bytes for the secrets it planted.
 */

import sharp from "sharp"

import { NotAPhotoError, stripPhotoMetadata } from "../lib/exif.ts"

/**
 * JPEG layout: 0xFFD8 (SOI), then segments of 0xFF <marker> <2-byte length>
 * <payload>, until 0xFFDA (SOS) after which comes entropy-coded pixel data.
 */
function scanSegments(buf) {
  const found = []
  if (buf[0] !== 0xff || buf[1] !== 0xd8) throw new Error("not a JPEG (no SOI marker)")
  let i = 2
  while (i < buf.length - 1) {
    if (buf[i] !== 0xff) break
    const marker = buf[i + 1]
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2
      continue
    }
    if (marker === 0xda) break
    const len = buf.readUInt16BE(i + 2)
    const payload = buf.subarray(i + 4, i + 2 + len)
    found.push(
      marker === 0xe0 ? "APP0/JFIF"
      : marker === 0xe1 ? `APP1(${payload.subarray(0, 4).toString("latin1")})`
      : marker === 0xe2 ? "APP2/ICC"
      : marker === 0xed ? "APP13/IPTC"
      : marker === 0xee ? "APP14/Adobe"
      : marker === 0xfe ? "COM"
      : `marker-0x${marker.toString(16)}`,
    )
    i += 2 + len
  }
  return found
}

const contains = (buf, s) => buf.includes(Buffer.from(s, "latin1"))

let failures = 0
function check(label, ok, detail) {
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`)
  if (!ok) failures++
}

/**
 * Values planted in the fixture that are stored as plain ASCII, so a raw byte
 * grep can find them afterwards.
 *
 * GPS coordinates are deliberately not in this list. EXIF stores them as
 * binary rationals, not text, so grepping for "47.3769" would never match and
 * would report a pass while testing nothing. GPS removal is proven instead by
 * the structural check below: the GPS IFD can only exist inside the APP1/Exif
 * segment, so no APP1/Exif means no GPS.
 */
const ASCII_SECRETS = ["TestCam", "GPS-Enabled", "sensitive-owner-name"]

// --- Fixture: a JPEG carrying camera identity and home coordinates -----------
const withExif = await sharp({
  create: { width: 400, height: 300, channels: 3, background: "#7a5c3e" },
})
  .withMetadata({
    exif: {
      IFD0: { Make: "TestCam", Model: "GPS-Enabled", Copyright: "sensitive-owner-name" },
      GPS: {
        GPSLatitudeRef: "N",
        GPSLatitude: "47.3769",
        GPSLongitudeRef: "E",
        GPSLongitude: "8.5417",
      },
    },
  })
  .jpeg()
  .toBuffer()

console.log("fixture")
console.log(`  segments: ${scanSegments(withExif).join(", ")}`)
// If the fixture carries nothing, every check below would pass against an
// empty input and prove nothing at all.
check("fixture carries an Exif header", contains(withExif, "Exif\0\0"), "else this test is vacuous")
const plantedInFixture = ASCII_SECRETS.filter((s) => contains(withExif, s))
check(
  "fixture carries every planted ASCII secret",
  plantedInFixture.length === ASCII_SECRETS.length,
  `found ${plantedInFixture.length}/${ASCII_SECRETS.length}: ${plantedInFixture.join(", ") || "none"}`,
)
// A GPS IFD lives inside APP1/Exif, so its presence in the fixture is what
// makes the "no APP1/Exif afterwards" check below mean something for GPS.
check("fixture carries an APP1/Exif segment to host the GPS IFD", scanSegments(withExif).some((s) => s.startsWith("APP1(Exif")))

// --- Strip -------------------------------------------------------------------
const stripped = await stripPhotoMetadata(withExif)

console.log("\nafter stripPhotoMetadata")
const outSegs = scanSegments(stripped)
console.log(`  segments: ${outSegs.join(", ") || "(none)"}`)

// This is also the GPS proof: no APP1/Exif segment, nowhere for a GPS IFD.
check("no APP1/Exif segment (and therefore no GPS IFD)", !outSegs.some((s) => s.startsWith("APP1(Exif")))
check("no IPTC segment", !outSegs.includes("APP13/IPTC"))
check("no Exif header in raw bytes", !contains(stripped, "Exif\0\0"))
for (const secret of plantedInFixture) {
  check(`planted value gone from raw bytes: "${secret}"`, !contains(stripped, secret))
}
check(
  "still a decodable JPEG",
  stripped[0] === 0xff && stripped[1] === 0xd8 && stripped.length > 500,
  `${stripped.length} bytes`,
)

// --- Orientation is baked in, not merely discarded ---------------------------
// A 400x300 landscape image tagged "rotate 90°" must come out 300x400. If it
// came out 400x300 the tag was dropped without applying it, and every portrait
// photo at the party would render sideways.
const rotatedFixture = await sharp({
  create: { width: 400, height: 300, channels: 3, background: "#334455" },
})
  .withMetadata({ orientation: 6 })
  .jpeg()
  .toBuffer()
const rotatedOut = await stripPhotoMetadata(rotatedFixture)
const dims = await sharp(rotatedOut).metadata()
console.log("\norientation")
check(
  "orientation 6 is applied to pixels, not just dropped",
  dims.width === 300 && dims.height === 400,
  `${dims.width}x${dims.height} (want 300x400)`,
)

// --- Non-photo input is refused, not re-encoded -------------------------------
console.log("\nnon-JPEG input")
const png = await sharp({ create: { width: 10, height: 10, channels: 3, background: "#fff" } })
  .png()
  .toBuffer()
try {
  await stripPhotoMetadata(png)
  check("PNG is rejected", false, "it was accepted")
} catch (error) {
  check("PNG is rejected", error instanceof NotAPhotoError, error.constructor.name)
}

console.log(`\n${failures === 0 ? "All checks passed." : `${failures} check(s) FAILED.`}`)
process.exit(failures === 0 ? 0 : 1)
