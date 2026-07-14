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

Phase 2 of 5. Working today: event creation with host-set limits, QR/link join,
GDPR consent, and the whole capture flow — photo or 15s video, one local
preview, keep or retake, upload with server-side metadata stripping and quotas
enforced by the database.

| Phase | Scope | State |
| --- | --- | --- |
| 1 | Schema, tokens, join + consent | Done |
| 2 | Camera capture, upload, EXIF strip | Done |
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

Media lives in a private bucket. The browser gets a short-lived signed URL for
the one object it is uploading and nothing else — the bytes go straight to
Storage because a 15s clip is far larger than a route handler will accept, but
the server bookends it: `upload/init` decides whether the guest may shoot at
all, and `upload/confirm` strips the photo's metadata and moves the quota
counters. Nothing counts until confirm succeeds, so an abandoned upload leaves
an invisible `pending` row that the retention sweep clears within the hour.

Quotas are enforced by the database, not by the route. Each counter moves in a
single statement that carries its own limit (`update … where upload_count <
max_uploads_per_guest`), so a check cannot go stale between reading and
writing — twenty guests hitting Keep at the same second cannot all claim the
last slot.

`scripts/verify-exif.mjs` proves metadata stripping against raw JPEG segment
bytes rather than asking the imaging library to grade its own work.
`scripts/verify-upload.mjs` drives the real routes and reads each stored object
back through a signed URL — the same path the host reads — to prove what
actually landed in the bucket.

Known and accepted for the MVP: a guest can clear storage or switch devices to
get a fresh quota. Without accounts this is a soft cap backed by a host-visible
count, not a cryptographic guarantee. Video metadata is **not** stripped —
that needs a demuxer we do not ship, the consent notice says so plainly, and it
is a Phase 4 gap. Rate limiting and bot protection are deliberately deferred.

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

Then prove metadata stripping, and the upload path end to end (the latter needs
`npm run dev` running):

```bash
node --conditions=react-server --experimental-strip-types scripts/verify-exif.mjs
node --env-file=.env.local scripts/verify-upload.mjs
```

### If `fetch` fails with "unable to get local issuer certificate"

Node ships its own CA list rather than using the system keychain, so a machine
that inspects TLS will break `fetch` — and therefore `supabase-js` — while curl
keeps working. Point Node at the same bundle npm already uses:

```bash
export NODE_EXTRA_CA_CERTS="$HOME/.config/npm-certs.pem"
```

## Licence

Not yet chosen.
