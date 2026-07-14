/**
 * Proves the pre-unlock privacy claim at the database, not in the UI.
 *
 * The whole product rests on media being genuinely unreachable before the host
 * unlocks. That has to hold even for someone holding the anon key and talking
 * to Supabase directly, bypassing our routes entirely. This script is that
 * adversary: it takes the anon key and tries to read every table. Every
 * attempt must fail.
 *
 * Run: node --env-file=.env.local scripts/verify-rls.mjs
 */

import { createClient } from "@supabase/supabase-js"

const url = process.env.SUPABASE_URL
const anonKey = process.env.SUPABASE_ANON_KEY

if (!url || !anonKey) {
  console.error("Set SUPABASE_URL and SUPABASE_ANON_KEY in .env.local first.")
  process.exit(1)
}

const anon = createClient(url, anonKey, {
  auth: { persistSession: false, autoRefreshToken: false },
})

const TABLES = ["events", "guest_sessions", "media_items"]

let failures = 0

/** Postgres: permission denied for table. This is the REVOKE biting. */
const PERMISSION_DENIED = "42501"

/**
 * Only a real permission denial counts as proof.
 *
 * The tempting shortcut — treat any error as "blocked" — makes this script
 * lie: a DNS hiccup or an offline laptop would sail through as a pass while
 * proving nothing about RLS. So the denial has to be the one Postgres sends
 * when a role may not touch a table (42501), which lands before any row
 * filtering and therefore holds regardless of what the table contains.
 * Anything else is inconclusive, and inconclusive is a failure.
 */
function classify(error) {
  if (!error) return { ok: false, detail: "no error returned" }
  if (error.code === PERMISSION_DENIED) {
    return { ok: true, detail: `${error.code}: ${error.message}` }
  }
  return {
    ok: false,
    detail: `expected ${PERMISSION_DENIED}, got ${error.code || "no code"}: ${
      error.message || "no message"
    }`,
  }
}

for (const table of TABLES) {
  const { data, error } = await anon.from(table).select("*").limit(1)

  if (data && data.length > 0) {
    console.error(`FAIL  ${table}: anon key read ${data.length} row(s)`)
    failures++
    continue
  }

  const verdict = classify(error)
  if (verdict.ok) {
    console.log(`ok    ${table}: read blocked — ${verdict.detail}`)
  } else {
    console.error(`FAIL  ${table}: read not provably blocked — ${verdict.detail}`)
    failures++
  }
}

const { error: insertError } = await anon
  .from("events")
  .insert({ name: "rls probe", guest_token: "probe", host_token: "probe" })

const insertVerdict = classify(insertError)
if (insertVerdict.ok) {
  console.log(`ok    events: insert blocked — ${insertVerdict.detail}`)
} else {
  console.error(
    `FAIL  events: insert not provably blocked — ${insertVerdict.detail}`,
  )
  failures++
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed — RLS is not holding.`)
  process.exit(1)
}

console.log("\nAll checks passed: the anon key cannot read or write any table.")
