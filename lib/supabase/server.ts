import "server-only"

import { createClient, type SupabaseClient } from "@supabase/supabase-js"

import type { Database } from "./types"

/**
 * The only door to the database.
 *
 * Every table runs default-deny RLS with no policies for anon/authenticated,
 * and this client authenticates as service_role, which bypasses RLS. So the
 * route handler that calls it *is* the access check — there is no second gate
 * behind it. Read that as: never hand a request's own claims to this client
 * without having already decided the caller is allowed.
 *
 * No Supabase key is ever shipped to the browser; the `server-only` import
 * turns any client-side import of this module into a build error rather than
 * a leaked service_role key.
 */

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(
      `Missing required environment variable: ${name}. See .env.local.example.`,
    )
  }
  return value
}

let cached: SupabaseClient<Database> | undefined

export function supabaseAdmin(): SupabaseClient<Database> {
  cached ??= createClient<Database>(
    requireEnv("SUPABASE_URL"),
    requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
    // Nothing here is a logged-in user, so there is no session to persist
    // or refresh. Turning both off keeps the client stateless and safe to
    // share across requests.
    { auth: { persistSession: false, autoRefreshToken: false } },
  )
  return cached
}
