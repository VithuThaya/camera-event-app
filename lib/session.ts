import "server-only"

import { SignJWT, jwtVerify } from "jose"
import { cookies } from "next/headers"

/**
 * Guest and host sessions.
 *
 * There are no accounts. A session is a signed cookie holding the event it
 * belongs to and, for guests, which guest_sessions row is theirs. Two claims
 * carry the security weight:
 *
 *   role — a guest cookie must never satisfy a host check. The guest link is
 *          handed to everyone at the party; the host link is the only thing
 *          guarding unlock and delete.
 *   eid  — a cookie minted for one event must not be replayable against
 *          another. Every read is told which event is being accessed and
 *          rejects a mismatch.
 */

const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30 // 30 days
const ALGORITHM = "HS256"

let cachedSecret: Uint8Array | undefined

function secret(): Uint8Array {
  if (!cachedSecret) {
    const value = process.env.SESSION_SECRET
    if (!value || value.length < 32) {
      throw new Error(
        "SESSION_SECRET must be set to at least 32 characters. See .env.local.example.",
      )
    }
    cachedSecret = new TextEncoder().encode(value)
  }
  return cachedSecret
}

/**
 * Cookie names are scoped per event. One shared name would mean that joining
 * a second event silently replaces the first event's session — handing the
 * guest a fresh upload quota and losing the shots they already took.
 */
function guestCookieName(eventId: string): string {
  return `ce_g_${eventId}`
}

function hostCookieName(eventId: string): string {
  return `ce_h_${eventId}`
}

function cookieOptions() {
  return {
    httpOnly: true,
    /**
     * Lax, not Strict. Guests arrive by scanning a QR code or tapping a link
     * inside WhatsApp or Instagram, which is a cross-site top-level
     * navigation — Strict would withhold the cookie there, the server would
     * read them as a brand-new guest, and their spent upload quota would
     * reset on every revisit.
     *
     * Lax still withholds the cookie from cross-site POST/fetch, which is
     * what CSRF needs. That covers us because every state-changing route is
     * POST/PATCH/DELETE; no GET in this app mutates anything.
     */
    sameSite: "lax" as const,
    // Dev runs on plain-http localhost, where a Secure cookie is dropped.
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  }
}

export type GuestSession = { eventId: string; guestSessionId: string }
export type HostSession = { eventId: string }

async function sign(claims: Record<string, string>): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: ALGORITHM })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_TTL_SECONDS}s`)
    .sign(secret())
}

async function verify(token: string): Promise<Record<string, unknown> | null> {
  try {
    // Pinning the algorithm rejects a token that asks to be verified with
    // something weaker, or with "none".
    const { payload } = await jwtVerify(token, secret(), {
      algorithms: [ALGORITHM],
    })
    return payload
  } catch {
    // Expired, tampered, or malformed all mean the same thing to callers:
    // there is no session.
    return null
  }
}

export async function setGuestSession(session: GuestSession): Promise<void> {
  const token = await sign({
    role: "guest",
    eid: session.eventId,
    sid: session.guestSessionId,
  })
  const store = await cookies()
  store.set(guestCookieName(session.eventId), token, cookieOptions())
}

export async function readGuestSession(
  eventId: string,
): Promise<GuestSession | null> {
  const store = await cookies()
  const raw = store.get(guestCookieName(eventId))?.value
  if (!raw) return null

  const payload = await verify(raw)
  if (!payload) return null
  if (payload.role !== "guest") return null
  if (payload.eid !== eventId) return null
  if (typeof payload.sid !== "string") return null

  return { eventId, guestSessionId: payload.sid }
}

export async function setHostSession(session: HostSession): Promise<void> {
  const token = await sign({ role: "host", eid: session.eventId })
  const store = await cookies()
  store.set(hostCookieName(session.eventId), token, cookieOptions())
}

export async function readHostSession(
  eventId: string,
): Promise<HostSession | null> {
  const store = await cookies()
  const raw = store.get(hostCookieName(eventId))?.value
  if (!raw) return null

  const payload = await verify(raw)
  if (!payload) return null
  if (payload.role !== "host") return null
  if (payload.eid !== eventId) return null

  return { eventId }
}
