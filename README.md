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

All five phases are in. The whole arc works end to end: create an event with
your own limits, share the QR, guests consent and shoot, nothing is visible to
anyone, then you unlock — and the roll is yours to browse, run as a slideshow,
or download as one ZIP. A shot taken where there is no signal waits on the phone
and goes up on its own.

| Phase | Scope | State |
| --- | --- | --- |
| 1 | Schema, tokens, join + consent | Done |
| 2 | Camera capture, upload, EXIF strip | Done |
| 3 | Unlock, host gallery, slideshow, ZIP download | Done |
| 4a | Offline capture queue | Done |
| 4b | Retention cron, deletion warnings | Done |
| 5 | Film-look UI pass | Done |

Three things still need a physical phone before any of this is claimed to work
in someone's hand — see [What no script here can prove](#what-no-script-here-can-prove).

## Stack

Next.js 16 (App Router) with Node-runtime route handlers, Supabase Postgres +
Storage, deployed as a single Vercel project. No separate backend service.

## The look

A darkroom: a warm near-black room, warm off-white text, and a single amber
safelight as the only accent. Nothing else is allowed to be colourful, because
the photographs are. Surfaces lift by getting lighter and warmer rather than by
casting a shadow — a drop shadow on near-black is invisible, and every attempt
to make it visible ends in a grey halo that reads as a rendering bug. There is
no light theme: the gallery and the slideshow are the product and both get
looked at in a dim room.

**The grain never touches a photograph.** It lives in `body`'s
`background-image`, not in an overlay, and that is the whole reason: an overlay
covering the viewport covers the photographs too, and the promise is that what
the host sees on screen is what is in the file they download. As a background it
sits behind every descendant by construction — there is no z-index for anyone to
get wrong later. Nothing in the gallery, lightbox or slideshow carries a
`filter`, `mix-blend-mode`, `backdrop-filter` or colour wash. The frame *around*
a photo is pure black rather than the room's warm black, deliberately against
the palette: a warm surround shifts how the eye reads the skin tones inside it.

Its strength is measured rather than chosen. `feTurbulence` with `fractalNoise`
emits noise on all four channels including alpha, so at the 0.4 it started on,
the rect rendered as half-opaque mid-grey and lifted the room to a washed-out
grey-brown with no darkroom left. A `feColorMatrix` kills the colour noise —
which no film stock ever had — and at 0.055 the room measures `#0f0e0d` against
its `#0a0908` token.

One accent means one lit thing per screen. The shutter is the exception and
stays white: it is the control a guest has to find one-handed, in the dark,
without looking, and white on black is the highest contrast a screen can make.
The QR code is the other, for the same kind of reason — it is read by a camera
that needs real contrast, and tinting it to suit the room produces a poster
nobody can scan across a dim venue.

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
the one that serves the whole party's photos.

That single home is also why the gallery's "Slideshow" and "Download all" live
inside `GalleryGrid` rather than in the page around it. The page deliberately
does not know whether the roll is open — only the route does, and the grid is
what it answers. While those buttons sat in the page header they rendered over a
sealed event too, so a host arriving at the gallery URL directly was offered a
lit "Download all" that answered 403 with a raw JSON body in their browser
window. Nothing was exposed — the server refused, as it is supposed to — but the
interface was lying, and the fix is to let the component that already knows do
the deciding rather than to teach the page the rule a second time. The host is gated by their own
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
an invisible `pending` row, which the nightly sweep clears once it is an hour
old. An hour is when it *becomes* sweepable, not when it goes: the sweep runs at
03:00, so such an object can sit in the bucket for the better part of a day.
That matters more than its size suggests — `confirm` never ran on it, so its
EXIF was never stripped. It is unreachable by anyone in the meantime, since
nothing but a signed URL can read the bucket and none is ever minted for it.

A shot that finds no network is written to IndexedDB rather than lost. The
places people take the best photos — a cellar bar, a stone church, a marquee in
a field — are the places with no bars, and a guest with twenty shots cannot be
asked to check their signal before each one. What is stored is the capture, not
the reservation: a signed upload URL expires in 60 seconds, so persisting one
would persist rubbish. The queue then goes up on the `online` event, when the
tab is looked at again, on the next page load, or when the guest taps the
button — four triggers because no single one of them is honest on a phone
drifting between saturated venue wifi and 4G.

Sending a queued shot twice would spend two of the guest's allowance on one
photo, so two things stop it. A flusher claims an item inside a single
IndexedDB transaction, which serialises two tabs racing each other; and the
queue records the mediaId only once the bytes are provably in the bucket, so a
resumed upload knows whether to start over from init (nothing was spent, the
orphan is swept within the day) or to retry confirm alone (which the server
answers idempotently). The one case left is a flush killed mid-upload and
reclaimed after its five-minute lease while the original is somehow still
running — narrower than the soft quota cap below, and bounded by the same
server-side counters.

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

The deletion the consent notice promises is carried out by one nightly cron
(`0 3 * * *`), and it is the only thing that makes that promise true rather than
decorative. It does not decide the date: it reads `retentionDeadline()` and
`unlockMoment()` — the same two functions the host's countdown is drawn from —
because a sweep with its own opinion of the date would delete media on a day the
host was never shown. The clock starts at the reveal, not at creation, so an
event made in January and unlocked in June keeps its media until June plus
`retention_days`; an event never unlocked has no deadline and never expires.
`CRON_SECRET` is the whole gate, compared in constant time, and the route
refuses to run at all when it is unset — a deploy that forgets it stops deleting
rather than starts deleting for anyone who finds the URL.

`scripts/verify-exif.mjs` proves metadata stripping against raw JPEG segment
bytes rather than asking the imaging library to grade its own work.
`scripts/verify-upload.mjs` drives the real guest routes and reads each stored
object back through a signed URL — the same path the host reads — to prove what
actually landed in the bucket. `scripts/verify-host.mjs` drives the real host
routes: 95 checks covering the pre-unlock 403 on a direct call, guest tokens
against every host route, `unlocked_at` surviving a replay and a three-way
race, the ZIP's own bytes, and the abandoned object really leaving Storage on
delete. `scripts/verify-retention.mjs` runs the real cron route against
backdated events: every deletion it checks is paired with a survival check,
because a sweep that deleted every event on earth would pass a test that only
looks at the one it was supposed to take.

There is no service worker, so a queued shot goes up while the tab is alive or
when it is opened again — not while the browser is closed. Background Sync
would cover that last case on Chrome and never on iOS, and it cannot reuse the
upload path: service workers have no `XMLHttpRequest`, which is what the upload
uses to report progress. It would therefore mean a second, hand-written copy of
the code that spends guests' quota, drifting out of step with the first. The
four page-driven triggers cover every browser instead of adding a fifth that
covers one.

There is no web app manifest either. Its only job would be Add to Home Screen,
and the promise on the tin is that a guest scans a QR and shoots — nobody
installs an app for one evening.

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
node --env-file=.env.local scripts/verify-retention.mjs
```

Each must exit 0. They create their own events and delete them afterwards.
`verify-retention.mjs` additionally needs `CRON_SECRET` set to the same value the
dev server was started with — it calls the cron route the way Vercel does.

### What no script here can prove

The offline queue has no verification script, because the thing worth proving
about it only exists in a browser: IndexedDB, `XMLHttpRequest`, the `online`
event, a real camera. A Node harness for it would be four shims deep and would
mostly test the shims. It was verified instead by driving the real capture
screen in Chrome with the network cut at the CDP level — capture offline, watch
the server stay empty, reconnect, watch the shot arrive confirmed and stripped
and counted exactly once.

The look has no script either, for the same reason, but the two claims worth
holding it to were measured in the browser rather than eyeballed. That the room
is really Geist and not the fallback: the same string measures 663.11px under
the body stack and under Geist, and 656.47px under Arial — `getComputedStyle`
reports what the CSS asks for, not what rendered, and it said "Geist" the whole
time the app was actually drawing Arial. That the grain cannot reach a
photograph: of 432 CSS rules, the only three mentioning it all target `body` and
all carry it as a background property; no viewport-sized element and no `body`
pseudo-element exists; and a rendered gallery photo reports `filter: none`,
`mix-blend-mode: normal`, `backdrop-filter: none`, `opacity: 1`.

Three things still need a real device and are not claimed to work until someone
checks them:

- **iOS Safari.** It is the phone half the guests will be holding and the only
  engine whose IndexedDB and background-tab behaviour we are trusting on
  reputation. Capture in airplane mode, lock the phone, come back, reconnect.
- **Real video sizes.** `videoBitsPerSecond` is a hint, not a contract. The
  ~5 MB estimate the 15s cap rests on has never met an actual phone.
- **Video through the queue.** Only photos have made the offline round trip; a
  40 MB clip is the same code path with a much longer PUT.

### If the app renders in Arial

It did, from Phase 1 until Phase 5. `create-next-app` leaves
`body { font-family: Arial, Helvetica, sans-serif }` in `globals.css`, which
silently overrides the Geist that `next/font` loads and that `@theme` maps into
`--font-sans`. Both fonts were fetched on every visit and neither was ever
shown, and nothing failed — no error, no warning, and `getComputedStyle` cannot
see it. The Arial that remains in the built CSS is `next/font`'s own
metric-adjusted fallback (`@font-face { font-family: Geist Fallback; src:
local(Arial) }`) and belongs there.

### If routes 404 in dev that exist on disk

`next build` and `next dev` share the `.next` directory and do not agree about
what belongs in it. Running the production build and then starting the dev
server leaves a state where some routes resolve and others return Next's own 404
page — nested ones go first, so `/api/host/[hostToken]` keeps working while
`/api/host/[hostToken]/unlock` disappears, which reads exactly like a bug in the
route you just wrote. `rm -rf .next` and restart. Worth knowing before you spend
an hour debugging code that was never broken.

### If `fetch` fails with "unable to get local issuer certificate"

Node ships its own CA list rather than using the system keychain, so a machine
that inspects TLS will break `fetch` — and therefore `supabase-js` — while curl
keeps working. Point Node at the same bundle npm already uses:

```bash
export NODE_EXTRA_CA_CERTS="$HOME/.config/npm-certs.pem"
```

## Licence

Not yet chosen.
