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
