import "server-only"

import sharp from "sharp"

/**
 * Metadata stripping for photos.
 *
 * This runs on the server, in upload/confirm, before a row is ever allowed to
 * reach 'confirmed'. Doing it in the browser instead would put the one promise
 * the privacy notice actually makes — that a photo taken in someone's home
 * does not carry that home's coordinates — behind a check the client could
 * skip by not running our JavaScript.
 *
 * Videos are not covered. Stripping GPS atoms from an mp4 needs a demuxer we
 * do not ship, so callers pass exif_stripped=false for clips and the notice
 * says so. See the Phase 4 gap in the plan.
 */

/** Roughly 16k x 16k. A guard against a decompression bomb sized to exhaust
 *  the function's memory rather than to be looked at. */
const MAX_INPUT_PIXELS = 268_402_689

export class NotAPhotoError extends Error {}
export class MetadataStillPresentError extends Error {}

/**
 * Returns re-encoded JPEG bytes with no metadata attached.
 *
 * rotate() comes first and matters: EXIF carries the orientation the camera
 * was held at, and the pixels themselves are stored unrotated. Strip the tag
 * without baking in the rotation and every photo shot in portrait renders on
 * its side — a privacy fix that silently ruins the gallery.
 */
export async function stripPhotoMetadata(input: Buffer): Promise<Buffer> {
  const image = sharp(input, { limitInputPixels: MAX_INPUT_PIXELS })

  const metadata = await image.metadata()
  // The client encodes with canvas.toBlob('image/jpeg'). Anything else reached
  // us by a route we did not build, so we decline rather than re-encode it —
  // sharp will happily rasterise an SVG, and an SVG is not a photograph.
  if (metadata.format !== "jpeg") {
    throw new NotAPhotoError(`Expected a JPEG, got ${metadata.format ?? "unknown"}`)
  }

  // sharp drops all metadata on re-encode unless withMetadata() asks for it
  // back. rotate() applies the orientation tag to the pixels on the way.
  const output = await image.rotate().jpeg({ quality: 90, mozjpeg: true }).toBuffer()

  // Verify rather than assume. This is the whole point of the function, it
  // costs one cheap header parse, and a future sharp upgrade that changed the
  // default would otherwise turn every photo's exif_stripped=true into a
  // false claim with nothing failing loudly.
  const check = await sharp(output).metadata()
  if (check.exif || check.xmp || check.iptc) {
    throw new MetadataStillPresentError(
      "Re-encoded image still carries metadata; refusing to record it as stripped",
    )
  }

  return output
}
