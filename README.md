# Shared camera for your event

Everyone shoots. Nobody peeks. You reveal.

A web app for shared event photography — weddings, bachelor parties, birthdays,
group trips, school events. The host creates an event, sets the rules, and
shares one QR code. Guests join in their browser: **no app, no signup**. Each
gets a handful of shots. Nothing is visible to anyone until the host unlocks it,
and only the host collects the roll afterwards — to run as a slideshow at the
party, or to download and share.

## Why the constraints are the product

- **Few shots per guest.** Scarcity is the feature. Twenty deliberate photos
  beat two thousand blurry ones.
- **Delayed reveal.** Guests can't scroll a feed mid-party, because there is no
  feed. They shoot and stay present.
- **Private by default.** Guests never get a gallery. The host decides what the
  event looks like when it's over.

## Status

Phase 1 of 5. Working today: event creation with host-set limits, QR/link join,
GDPR consent, guest sessions with per-guest upload quotas.

| Phase | Scope | State |
| --- | --- | --- |
| 1 | Schema, tokens, join + consent | Done |
| 2 | Camera capture, upload, EXIF strip | Next |
| 3 | Unlock, host gallery, slideshow, ZIP download | Next |
| 4 | Offline queue, retention cron | Planned |
| 5 | Film-look UI pass | Planned |

## Stack

Next.js 16 (App Router) with Node-runtime route handlers, Supabase Postgres +
Storage, deployed as a single Vercel project. No separate backend service.

## Security model

The browser never talks to Supabase. Every table runs RLS with **no policies**
for `anon`/`authenticated`, and privileges are revoked on top — so the anon key
is denied at two independent layers. All access goes through route handlers
holding the `service_role` key, which makes the handler itself the access check.
`scripts/verify-rls.mjs` proves this against the live database rather than
asserting it.

Guest and host tokens are drawn independently from the CSPRNG (128-bit and
256-bit). The guest link goes to the whole party; the host link is the only
thing guarding unlock and delete, so leaking one must reveal nothing about the
other. Sessions are signed cookies carrying a role and an event id, so a guest
cookie cannot satisfy a host check and a cookie from one event cannot be
replayed at another.

Known and accepted for the MVP: a guest can clear storage or switch devices to
get a fresh quota. Without accounts this is a soft cap backed by a host-visible
count, not a cryptographic guarantee. Rate limiting and bot protection are
deliberately deferred.

## Setup

```bash
npm install
cp .env.local.example .env.local   # then fill in the values
npm run dev
```

Apply `supabase/migrations/0001_init_schema.sql` to a Supabase project, then
verify the database actually denies the anon key:

```bash
node --env-file=.env.local scripts/verify-rls.mjs
```

Every check must print `42501: permission denied`. Anything else means RLS is
not holding.

### If `fetch` fails with "unable to get local issuer certificate"

Node ships its own CA list rather than using the system keychain, so a machine
that inspects TLS will break `fetch` — and therefore `supabase-js` — while curl
keeps working. Point Node at the same bundle npm already uses:

```bash
export NODE_EXTRA_CA_CERTS="$HOME/.config/npm-certs.pem"
```

## Licence

Not yet chosen.
