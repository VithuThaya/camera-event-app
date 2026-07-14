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

Phase 3 of 5. The whole arc works end to end: create an event with your own
limits, share the QR, guests consent and shoot, nothing is visible to anyone,
then you unlock — and the roll is yours to browse, run as a slideshow, or
download as one ZIP.

| Phase | Scope | State |
| --- | --- | --- |
| 1 | Schema, tokens, join + consent | Done |
| 2 | Camera capture, upload, EXIF strip | Done |
| 3 | Unlock, host gallery, slideshow, ZIP download | Done |
| 4 | Offline queue, retention cron | Next |
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
other. A guest's session is a signed cookie carrying a role and an event id, so
it cannot be replayed at another event.

There is no host cookie, deliberately. The host token in the URL is the
credential, re-checked against the database on every host request. A cookie
could not add a second factor — every host request already carries the token,
so anyone who can send one could mint the cookie too — while it *would* add a
CSRF surface, because a cookie-authenticated POST can be forged by any page the
host visits and a URL-borne credential cannot. It would also outlive its tab: a
30-day cookie left on the party laptop is a worse leak than the URL it replaced.
Phase 1's unused `setHostSession`/`readHostSession` were removed in Phase 3 for
the same reason — dead auth helpers get wired up by someone who assumes they
gate something.

The reveal is one gate in one place (`isEventUnlocked` in `lib/events.ts`,
reached through `gateHostMedia`). Gallery, slideshow and download-all all ask
it, and the plan's separate `/slideshow` route was deliberately not built: two
routes are two places to remember the check, and the one that gets forgotten is
the one that serves the whole party's photos. The host is gated by their own
unlock even though they can lift it in one tap — that tap stamps `unlocked_at`
and starts the retention clock, so the reveal cannot happen quietly. That stamp
is written exactly once: every unlock write carries "and the event is still
locked" in its WHERE clause, so racing requests cannot move the deletion date.

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

Deleting an event erases the bytes first and marks the rows second, so a crash
in between leaves the media gone rather than an event marked deleted with the
photos still sitting there. The purge works from the bucket listing, not from
`media_items` rows: an abandoned upload leaves an object whose row never
reached `confirmed`, which means `confirm` never ran and its metadata was never
stripped. A row-driven delete would walk straight past exactly that file.

`scripts/verify-exif.mjs` proves metadata stripping against raw JPEG segment
bytes rather than asking the imaging library to grade its own work.
`scripts/verify-upload.mjs` drives the real guest routes and reads each stored
object back through a signed URL — the same path the host reads — to prove what
actually landed in the bucket. `scripts/verify-host.mjs` drives the real host
routes: 95 checks covering the pre-unlock 403 on a direct call, guest tokens
against every host route, `unlocked_at` surviving a replay and a three-way
race, the ZIP's own bytes, and the abandoned object really leaving Storage on
delete.

Known and accepted for the MVP: a guest can clear storage or switch devices to
get a fresh quota. Without accounts this is a soft cap backed by a host-visible
count, not a cryptographic guarantee. Video metadata is **not** stripped —
that needs a demuxer we do not ship, the consent notice says so plainly, and it
is a Phase 4 gap. Rate limiting and bot protection are deliberately deferred.

The host link is the whole credential, and the slideshow puts it on a screen in
front of a room. Fullscreen hides the URL bar, but a photograph of the address
bar is a full compromise — inherent to account-less URL tokens, which is why
the create screen says the link is unrecoverable and private.

`download-all` is bounded by wall-clock, not memory: it streams one object at a
time, but Vercel's Hobby plan cuts a function off at 60s, so a large event over
a slow connection will break off mid-file. The gallery's per-item downloads are
the honest fallback; fixing it properly needs a paid plan or a pre-built
archive in Storage.

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

Then prove metadata stripping, and the guest and host paths end to end (the
latter two need `npm run dev` running):

```bash
node --conditions=react-server --experimental-strip-types scripts/verify-exif.mjs
node --env-file=.env.local scripts/verify-upload.mjs
node --env-file=.env.local scripts/verify-host.mjs
```

Each must exit 0. They create their own events and delete them afterwards.

### If `fetch` fails with "unable to get local issuer certificate"

Node ships its own CA list rather than using the system keychain, so a machine
that inspects TLS will break `fetch` — and therefore `supabase-js` — while curl
keeps working. Point Node at the same bundle npm already uses:

```bash
export NODE_EXTRA_CA_CERTS="$HOME/.config/npm-certs.pem"
```

## Licence

Not yet chosen.
