# FDFPV Leaderboard

The public board for [FDFPV](https://github.com/fdflabs/fdfpv), a GPLv3 fork of
[WebFPVSimulator](https://github.com/fdflabs/fdfpv).
Every published course lives here, with the times flown on it.

The page has two tabs. **Tracks and times** is the board itself. **Site
statistics** is a page of counters about the product: how many are flying
now, pilots and laps by day, which countries, which sponsors' links people
arrived from, and what they fly on. See [Site statistics](#site-statistics)
below for what is counted and, more to the point, what is not.

Repository: [fdflabs/fdfpv-leaderboard](https://github.com/fdflabs/fdfpv-leaderboard).

The simulator itself keeps nothing. Tracks you build stay in that browser
until you publish them. This page is the copy that other people can fly.

## How the three pages connect

The track document from the builder is the only payload. Up to five
sponsors' marks travel inside it, so a published course wears its sponsor
print on the gates, the upright banners, the flags and any footprint its
author painted on the grass. A mark on the grass is dressing rather than
layout, so adding a sponsor to a course people have already flown does not
clear the times on it.

```
Track builder                 This board                    Simulator
-------------                 ----------                    ---------
Publish  ------------------>  stores the course
                              Fly this course  ---------->  ?map=custom&share={id}
                                                            Post this time  ----->  that course's times
```

A Fly link looks like this:

```
{sim}/?map=custom&share=trk-1a2b3c4d&board={this origin}
```

The simulator fetches `/api/tracks/{id}/document`, builds the world, and
offers to post a lap time back here under the pilot's name.

The **FDFPV** mark, in the masthead and again in the sticky spine, is the
way back to the front door, and it opens in this tab rather than the
simulator's: it is a way back, and a way back that leaves this page open
behind it is not one. Where the front door is comes from `public/origins.js`
without asking the server, the same way the simulator's address does. A
checkout finds it on `http://127.0.0.1:8080`, the `/board` mount finds
whatever it hangs off, and anything else is `https://fdfpv.example`, which is
the one line a fork changes.

## Run locally

Node 22 or newer. No database required: a JSON file in `data/` is enough.

```bash
git submodule update --init   # the simulator, pinned under vendor/fdfpv
npm install
npm start          # http://127.0.0.1:3180/
```

The simulator is checked out under `vendor/fdfpv` at a pinned commit, not
recursively, so its own Betaflight submodule stays out. The board imports
the lap check from it (`src/game/verify.js`) and its selftest imports the
synthetic laps, so the board and the simulator can never disagree about
what a gate is. A host that clones without submodules fails at start with
a missing module, on purpose.

Point the simulator at this board by leaving the default
`http://127.0.0.1:3180` in the builder's Publish dialog, or by opening a
Fly link from this page.

```bash
npm test
```

## Postgres, when you want it

Set `DATABASE_URL` and the same process uses the schema in `schema.sql`.
A local instance:

```bash
docker compose up -d
DATABASE_URL=postgres://fdfpv:fdfpv@127.0.0.1:5432/fdfpvboard npm start
```

## Host on Render

`render.yaml` here is a blueprint for a Node web service plus a Postgres
instance, wired to each other. In the dashboard: **New**, **Blueprint**,
pick this repo. That is both halves of the board.

Then set one thing by hand, under the service's **Environment**:

```
SIM_ORIGIN = https://<the simulator's static site>   # or https://fdfpv.example/sim
```

No trailing slash. Until it is set the board runs fine but its Fly and
Build buttons point at `http://127.0.0.1:8000`.

Two things about hosting here that are easy to get wrong:

- **Postgres is not optional on Render.** The file store in `data/` is for
  your machine. Render's filesystem is ephemeral, so that file is wiped on
  every deploy and every restart, taking every course and every lap time
  with it. Check `GET /api/health` says `"store":"postgres"`.
- **The free Postgres instance is deleted after 30 days.** Not downgraded,
  deleted. Move to a paid instance before then if the board is meant to
  last, and check the current terms in the dashboard.

`BOARD_TRUST_PROXY` is already set to `1` in the blueprint, which is what
makes the board write `https://` Fly links from behind Render's TLS
termination rather than `http://` ones a browser refuses as mixed content.
Leave `BOARD_PUBLIC_ORIGIN` unset unless a custom domain confuses that, or
the board is mounted under a path such as `https://fdfpv.example/board`, where a
forwarded host cannot carry the path and this is the only way to say it.

The full walkthrough, including the simulator's static site and the order
to create things in, is in
[DEPLOY.md in the simulator repo](https://github.com/fdflabs/fdfpv/blob/main/DEPLOY.md).

## API

| Method | Path | What it does |
| --- | --- | --- |
| GET | `/api/tracks` | Every published course, with its best time |
| GET | `/api/tracks/:id` | That course and its leaderboard. Each time carries `{ id, hasGhost }` |
| GET | `/api/tracks/:id/document` | The full track document, marks included |
| POST | `/api/tracks` | Publish `{ author, document, editKey? }` |
| POST | `/api/tracks/:id/times` | Post `{ name, lapMs, ghost }`. The ghost is required and is checked against the track: 422 with the reason if it did not fly the course |
| GET | `/api/tracks/:id/times/:timeId/ghost` | That time's recorded lap, `{ id, name, lapMs, ghost }` |
| GET | `/api/tracks/:id/gif` | That room's card animation, as `image/gif` |
| POST | `/api/tracks/:id/gif` | Upload `{ gif, editKey? }`. Rooms only |
| POST | `/api/tracks/:id/remove` | Take it off the board. Admin only |
| POST | `/api/admin/login` | Sign in `{ email, password }`, get a session token |
| GET | `/api/admin/session` | Who the bearer token is, or a 401 |
| GET | `/api/config` | `{ simOrigin, boardOrigin }` |
| POST | `/api/stats/events` | Add one counted event. Answers 204 and stores no identifier |
| GET | `/api/stats` | The statistics page's numbers. Cached twenty seconds |
| POST | `/api/bugs` | Tester submit `{ kind, title, what, expected?, steps?, reporter?, context? }` |
| GET | `/api/bugs` | Ticket summaries, newest first. `?status=open` `?kind=visual` |
| GET | `/api/bugs/:id` | One full ticket, context included |
| POST | `/api/bugs/:id` | Update `{ status, resolution }` |

A first publish returns an `editKey`. Keep it in the browser that sent
the course. Publishing the same id again without that key is refused.
Changing the flying layout clears the old times, because they were flown
on a different course.

## Signing in

**Admin** in the masthead opens a sign in panel. An address on the board's
whitelist and its password get a session token, which the page keeps in
that tab's `sessionStorage` and sends as a bearer header on the admin
routes. It runs out after twelve hours, and closing the tab ends it sooner.

Signed in, the panel is the whole of what an admin can do:

- open any track and take it off the board, with every time flown on it,
- read the bugs inbox at `/bugs` without a separate `BUGS_TOKEN`.

There is no cookie and no session on the server. The token is signed rather
than stored, with a key derived from the whitelist itself, so it survives a
restart and a second instance, and **changing a password invalidates every
token that password minted**.

### The whitelist

`BOARD_ADMINS` on the service. One entry per line, or comma separated:

```
someone@example.com:scrypt:16384:8:1:<saltHex>:<hashHex>
```

Mint one without the password reaching a shell history:

```bash
node scripts/admin-hash.js someone@example.com
```

`BOARD_ADMINS` is the whole list. The repository ships no admin: until the
variable names somebody, nobody can sign in, and the board says so when it
starts. On a checkout, `someone@example.com:plain:a-password` is enough.

`BOARD_SESSION_SECRET` is optional and unset by default. It is mixed into
the signing key, so changing it signs every admin out at once without
anybody's password changing.

`email:plain:the password` is also accepted, for a local checkout. It is
not the right answer on a host, and a hash is one command away.

## Taking a track off the board

A signed in admin does it from the track's own sheet: open the track,
**Take off the board**, then press again to confirm. `BOARD_ADMIN_TOKEN`
is the other way in and is what a script uses, because a script has no
browser to sign in from:

```bash
curl -X POST https://fdfpv.example/board/api/tracks/trk-xxxxxxxx/remove \
  -H "Authorization: Bearer $BOARD_ADMIN_TOKEN"
```

An edit key is not a way in: it is enough to change a layout, which clears
times that were flown on a layout that no longer exists, and it is not
enough to delete other pilots' records outright.

It answers with what went: `{ id, name, author, times }`. The times go
with the track, and the id is free to publish again afterwards, which is
what makes this the way to replace a track published from a browser
nobody still has. The service logs the removal and who did it.

## The card animation

A room's card on the board is an animation of one lap of it, not a plan.
The board renders nothing: the GIF is drawn by the browser that publishes
the room, in `src/share/cardgif.js` in the simulator, and arrives here as
bytes. A field track is refused one, in `inspectGif`, because a sixty
metre course has a plan worth drawing and `public/plan.js` draws it from
the list payload for nothing.

Rooms published before any of that existed have no animation and no
reachable edit key. The simulator's `scripts/boardgif.js` draws theirs and
uploads them with `BOARD_ADMIN_TOKEN`.

`ghost` is the simulator's recorded lap, base64 of the wire format in its
`src/share/ghostdata.js`, attached when the lap was flown in the session
that posts it. The board validates the header against that format,
mirrored in `src/validate.js`, and refuses a blob that does not match the
lap time beside it. Times posted with a ghost show a mint chase link on
the board, and the simulator's Ghost row lists them as rivals.

## Site statistics

The second tab. It is **counters, never events**: the store holds one row
per UTC day and one row per day per dimension, and that is the finest grain
there is. There is no row anywhere in this repository that describes one
visitor, one visit or one lap.

What is stored, in `stats_days` and `stats_dims`:

| Counted | Where it comes from |
| --- | --- |
| Pilots, new and returning | one visit per browser per UTC day, from any of the three pages |
| Sessions | a simulator page load where the quad left the launch stand |
| Laps, flight time, crashes | deltas the simulator flushes once a minute |
| Country | two letters put on the request by the edge, never looked up here |
| Source | `direct`, a sponsor's slug, or `other` |
| Aircraft, input, map | the session that reported them |

What is **not** stored, and has no field in the wire format to arrive in: an
address, a user agent, a referrer, a screen size, a pilot name, a track id,
or any timestamp finer than the day. No cookie is set. The one per tab
string, used to answer "how many are flying now", is a random value the
browser makes at page load; the server holds it in memory for three minutes
and no table ever sees it.

New or returning is decided **by the browser**, from a first seen date it
keeps in its own local storage under `webfpv.stats.v1`. It sends the answer,
not the date.

Every dimension is a closed list, which is what stops a stranger with curl
growing a public table: `src/validate.js` refuses an aircraft or a page it
does not know, folds an unknown map or input into `other`, and
`src/sponsors.js` folds an unknown source into `other`. A flush is bounded
to what a minute can hold.

Turning it off. The page carries a **Count this browser** switch, and a
browser sending [Global Privacy
Control](https://globalprivacycontrol.org/) is never counted: the client
checks `navigator.globalPrivacyControl` and sends nothing, and the server
checks the `Sec-GPC` header and stores nothing.

### Sponsor links

`BOARD_SPONSORS` names them. One entry per line or comma separated:

```
BOARD_SPONSORS=rotorriot:Rotor Riot,fpvshop:The FPV Shop
```

A signed in admin sees each sponsor's ready link in the Admin panel:

```
{sim}/?utm_source=rotorriot&utm_medium=sponsor
```

The slug is what travels and must not change once a poster is printed; the
name is what the page prints and can. A visitor following one has the slug
stored in their own browser for thirty days and it rides on their events as
one of a handful of known words. Every `utm_` parameter is stripped from the
address bar on arrival, so a pilot who shares the link they are looking at
does not attribute their friend to a poster they never saw.

Unset is the right default and means no sponsors: every arrival is `direct`
or `other`. The per sponsor numbers are public on the statistics tab, on
purpose, so a sponsor can check them without asking anybody. The list of
sponsors is not, because it includes the ones with no traffic yet.

### The country

`edge/router.js` in the simulator's repository puts `x-fdfpv-country` on
the request from Cloudflare's own `request.cf.country`, overwriting anything
the client sent. The board believes the header only when `BOARD_TRUST_PROXY`
is `1`, exactly like the forwarded host. On a checkout that is unset, so
every row is `ZZ` and the page prints Unknown. On the bare Render address
it is set and there is no Worker in front, so an honest visitor is Unknown
and a client that writes the header itself is believed: the same trust that
address already extends to `x-forwarded-for`, on a public counter, and the
reason the domain rather than the bare address is the front door.

## Bug tickets

Testers click **Report a bug** in the simulator (or press F8). The form
lands here. The inbox page is `/bugs`. Agents should use the JSON API.

Kinds: `crash`, `blocking`, `wrong`, `visual`, `feel`, `other`.

Statuses: `open`, `in_progress`, `fixed`, `wontfix`, `duplicate`.

Submit is public. Listing and updating need `BUGS_TOKEN` when that
environment variable is set. Locally it is unset, so the tests and a
local agent can read tickets with no header.

```bash
# Open tickets, newest first
curl http://127.0.0.1:3180/api/bugs?status=open

# One ticket, including auto-captured map / GPU / browser
curl http://127.0.0.1:3180/api/bugs/bug-xxxxxxxx

# Claim it, then close it
curl -X POST http://127.0.0.1:3180/api/bugs/bug-xxxxxxxx \
  -H "content-type: application/json" \
  -d "{\"status\":\"in_progress\"}"

curl -X POST http://127.0.0.1:3180/api/bugs/bug-xxxxxxxx \
  -H "content-type: application/json" \
  -d "{\"status\":\"fixed\",\"resolution\":\"What you changed.\"}"
```

On a host with `BUGS_TOKEN` set, add
`-H "Authorization: Bearer $BUGS_TOKEN"` to the GET and update calls.
Testers never need that token, and neither does an admin signed in on the
board: the same tab's session opens this inbox too.

## Licence

GPLv3. See LICENSE.
