import { z } from "zod"

/**
 * Request validation.
 *
 * These bounds mirror the CHECK constraints in
 * supabase/migrations/0001_init_schema.sql. Both layers earn their keep: this
 * one turns a bad value into a readable message for the host, the database one
 * still holds if some future caller forgets to come through here.
 */

const MIB = 1024 * 1024
const GIB = 1024 * MIB

export const EVENT_LIMITS = {
  maxGuests: { min: 1, max: 500, default: 50 },
  maxUploadsPerGuest: { min: 1, max: 100, default: 20 },
  /**
   * The Supabase free tier caps Storage at 1 GB across the whole project, so
   * the default sits at 1 GiB rather than the 20 GiB ceiling. The ceiling is
   * headroom for a paid tier later; picking a default above what the tier can
   * actually hold would surface as a Supabase error mid-event instead of our
   * own "event storage full" message.
   */
  maxStorageBytes: { min: 100 * MIB, max: 20 * GIB, default: 1 * GIB },
  retentionDays: { min: 1, max: 365, default: 30 },
} as const

/**
 * Storage choices offered in the create form. Free-tier reality means the
 * larger options only make sense on a paid Supabase plan.
 */
export const STORAGE_PRESETS = [
  { label: "500 MB", bytes: 500 * MIB },
  { label: "1 GB", bytes: 1 * GIB },
  { label: "2 GB", bytes: 2 * GIB },
  { label: "5 GB", bytes: 5 * GIB },
] as const

export const createEventSchema = z.object({
  name: z.string().trim().min(1).max(120),
  maxGuests: z
    .number()
    .int()
    .min(EVENT_LIMITS.maxGuests.min)
    .max(EVENT_LIMITS.maxGuests.max),
  maxUploadsPerGuest: z
    .number()
    .int()
    .min(EVENT_LIMITS.maxUploadsPerGuest.min)
    .max(EVENT_LIMITS.maxUploadsPerGuest.max),
  maxStorageBytes: z
    .number()
    .int()
    .min(EVENT_LIMITS.maxStorageBytes.min)
    .max(EVENT_LIMITS.maxStorageBytes.max),
  retentionDays: z
    .number()
    .int()
    .min(EVENT_LIMITS.retentionDays.min)
    .max(EVENT_LIMITS.retentionDays.max),
  /**
   * Optional scheduled reveal. Null means the host will unlock by hand later.
   * A past timestamp is rejected: it would mean the event is already unlocked
   * before a single photo exists, which is never what the host meant.
   */
  unlockAt: z.iso
    .datetime()
    .nullable()
    .optional()
    .refine((value) => !value || new Date(value).getTime() > Date.now(), {
      message: "unlockAt must be in the future",
    }),
})

export type CreateEventInput = z.infer<typeof createEventSchema>

/**
 * Media bounds.
 *
 * Everything here is re-checked server-side against what actually landed in
 * the bucket. A client that lies at init only gets as far as confirm, where
 * the numbers come from Storage rather than from the request body.
 */
export const MEDIA_LIMITS = {
  photo: {
    mimeTypes: ["image/jpeg"],
    maxBytes: 12 * MIB,
  },
  video: {
    // Safari records mp4; Chrome and Firefox record webm. Supporting only one
    // would silently break capture on roughly half the phones at any party.
    mimeTypes: ["video/webm", "video/mp4"],
    // Mirrors the bucket's file_size_limit. The bucket is the real ceiling —
    // this copy just turns a rejection into a message we control.
    maxBytes: 40 * MIB,
    maxDurationSeconds: 15,
    /**
     * What we accept at the boundary. The product cap is 15s enforced by a
     * hard MediaRecorder stop, but container duration is rounded by the
     * encoder, so a clip cut at exactly 15s can report 15.04. Rejecting that
     * would fail an upload the guest did nothing wrong to produce. Matches the
     * CHECK constraint in 0001_init_schema.sql.
     */
    maxDurationToleranceSeconds: 16,
  },
} as const

export const uploadInitSchema = z
  .object({
    mediaType: z.enum(["photo", "video"]),
    mimeType: z.string().min(1).max(100),
    sizeBytes: z.number().int().positive(),
    durationSeconds: z.number().positive().nullable().optional(),
  })
  .superRefine((value, ctx) => {
    // Compare on the bare type: the client legitimately sends codec parameters.
    const mime = value.mimeType.split(";")[0]!.trim().toLowerCase()

    if (value.mediaType === "photo") {
      if (!MEDIA_LIMITS.photo.mimeTypes.includes(mime as "image/jpeg")) {
        ctx.addIssue({
          code: "custom",
          path: ["mimeType"],
          message: `Photos must be one of: ${MEDIA_LIMITS.photo.mimeTypes.join(", ")}`,
        })
      }
      if (value.sizeBytes > MEDIA_LIMITS.photo.maxBytes) {
        ctx.addIssue({
          code: "custom",
          path: ["sizeBytes"],
          message: "Photo is too large",
        })
      }
      // The database enforces this too (duration_only_for_video). Catching it
      // here keeps a nonsense payload from reaching the bucket at all.
      if (value.durationSeconds != null) {
        ctx.addIssue({
          code: "custom",
          path: ["durationSeconds"],
          message: "Photos carry no duration",
        })
      }
      return
    }

    if (!MEDIA_LIMITS.video.mimeTypes.includes(mime as "video/webm" | "video/mp4")) {
      ctx.addIssue({
        code: "custom",
        path: ["mimeType"],
        message: `Videos must be one of: ${MEDIA_LIMITS.video.mimeTypes.join(", ")}`,
      })
    }
    if (value.sizeBytes > MEDIA_LIMITS.video.maxBytes) {
      ctx.addIssue({
        code: "custom",
        path: ["sizeBytes"],
        message: "Video is too large",
      })
    }
    if (value.durationSeconds == null) {
      ctx.addIssue({
        code: "custom",
        path: ["durationSeconds"],
        message: "Videos must report a duration",
      })
    } else if (
      value.durationSeconds > MEDIA_LIMITS.video.maxDurationToleranceSeconds
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["durationSeconds"],
        message: `Videos must be at most ${MEDIA_LIMITS.video.maxDurationSeconds} seconds`,
      })
    }
  })

export type UploadInitInput = z.infer<typeof uploadInitSchema>

export const uploadConfirmSchema = z.object({
  mediaId: z.uuid(),
})

export type UploadConfirmInput = z.infer<typeof uploadConfirmSchema>

/**
 * The reveal, as the host can drive it.
 *
 * Three named intents rather than a free-form patch of unlock_at and
 * is_unlocked. Those two columns have to stay consistent with each other and
 * with unlocked_at, and letting a request set them individually is how they end
 * up disagreeing — an event claiming to be unlocked with no record of when,
 * which the database's own CHECK already refuses.
 *
 *   now      — reveal immediately, stamping the moment retention counts from.
 *   schedule — set or move a future reveal. Only while still locked.
 *   cancel   — drop a scheduled reveal, back to unlocking by hand.
 */
export const unlockSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("now") }),
  z.object({
    mode: z.literal("schedule"),
    // A past timestamp would mean "already revealed", which is what mode:"now"
    // is for. Accepting it here would unlock the event through a route the host
    // believes only schedules one.
    unlockAt: z.iso
      .datetime()
      .refine((value) => new Date(value).getTime() > Date.now(), {
        message: "unlockAt must be in the future",
      }),
  }),
  z.object({ mode: z.literal("cancel") }),
])

export type UnlockInput = z.infer<typeof unlockSchema>

/**
 * Settings the host can change after creation.
 *
 * Deliberately absent: guest_token, host_token, storage_used_bytes, and
 * anything about the unlock. Tokens are identity and cannot be rotated — the
 * guest link is already on a QR code taped to a table. storage_used_bytes is
 * the database's own running total and must never be settable from a request.
 * The unlock has its own route because it is not a setting, it is an event.
 */
export const hostSettingsSchema = z.object({
  name: z.string().trim().min(1).max(120),
  maxGuests: z
    .number()
    .int()
    .min(EVENT_LIMITS.maxGuests.min)
    .max(EVENT_LIMITS.maxGuests.max),
  maxUploadsPerGuest: z
    .number()
    .int()
    .min(EVENT_LIMITS.maxUploadsPerGuest.min)
    .max(EVENT_LIMITS.maxUploadsPerGuest.max),
  maxStorageBytes: z
    .number()
    .int()
    .min(EVENT_LIMITS.maxStorageBytes.min)
    .max(EVENT_LIMITS.maxStorageBytes.max),
  retentionDays: z
    .number()
    .int()
    .min(EVENT_LIMITS.retentionDays.min)
    .max(EVENT_LIMITS.retentionDays.max),
})

export type HostSettingsInput = z.infer<typeof hostSettingsSchema>

/**
 * Deleting an event is the one irreversible thing in this app, and the host
 * token alone is enough to do it. Requiring the event's own name back means a
 * mistyped or forged request fails: whoever sends it has to know what they are
 * destroying, not merely hold the link.
 */
export const deleteEventSchema = z.object({
  confirmName: z.string().min(1).max(120),
})

export type DeleteEventInput = z.infer<typeof deleteEventSchema>
