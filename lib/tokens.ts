import { randomBytes } from "node:crypto"

/**
 * Event access tokens.
 *
 * A guest token and a host token are drawn independently from the CSPRNG.
 * Neither is derived from the other, and neither is derived from the event id:
 * holding a guest link reveals nothing about the host link, which is the only
 * thing standing between a party guest and the unlock/delete controls.
 *
 * The host token is deliberately twice as wide. It is the sole credential for
 * an account-less event with no recovery path, so it gets the larger margin.
 */

const GUEST_TOKEN_BYTES = 16 // 128 bits -> 22 base64url chars
const HOST_TOKEN_BYTES = 32 // 256 bits -> 43 base64url chars

const GUEST_TOKEN_LENGTH = 22
const HOST_TOKEN_LENGTH = 43

const BASE64URL_ONLY = /^[A-Za-z0-9_-]+$/

export function generateGuestToken(): string {
  return randomBytes(GUEST_TOKEN_BYTES).toString("base64url")
}

export function generateHostToken(): string {
  return randomBytes(HOST_TOKEN_BYTES).toString("base64url")
}

/**
 * Shape checks, not authentication. They reject malformed URLs before a
 * database round-trip. Callers must answer a bad shape with the same flat 404
 * they give an unknown token, so a scanner learns nothing either way.
 */
export function isWellFormedGuestToken(value: string): boolean {
  return value.length === GUEST_TOKEN_LENGTH && BASE64URL_ONLY.test(value)
}

export function isWellFormedHostToken(value: string): boolean {
  return value.length === HOST_TOKEN_LENGTH && BASE64URL_ONLY.test(value)
}
