# CLAUDE.md

Project conventions. Read fully before any turn. These are decisions already made, not options.

## What this is

The public board for FDFPV, a GPLv3 fork of WebFPVSimulator. One Node service and one Postgres. It stores published courses and the times flown on them, and it serves a single static page that reads them back. It is not the simulator and it does not render anything: every course thumbnail on the board is the simulator's own `src/share/orbit.html`, in a cross origin iframe.

The three repositories are one product. `fdflabs/fdfpv` holds the simulator and the track builder and is the copy of record for anything shared; `fdflabs/fdfpv-landing` is the front door. Read the simulator's `CLAUDE.md` before changing anything that has to agree across the three, and `DEPLOY.md` there for how they are wired together.

## Decisions already made

**Licence is GPLv3.** Every file gets a header. Do not add a dependency with an incompatible licence.

**One runtime dependency, `pg`, and it is the only one.** The page has none at all: no framework, no bundler, no build step. Adding one needs an argument first.

**The page's styles are inline in the HTML.** Same reason as the simulator's: the styling must not depend on a server's MIME table.

**The palette is the simulator's, unchanged.** Cream for lit type, sakura for chrome, amber for an instrument, mint for a record, slate for type that should recede. A visitor arriving here from the simulator or the builder is looking at the same furniture, and that is deliberate.

**Nothing is ambiently authenticated, and no cookie is ever set.** Reflecting the request origin is therefore the same grant as `*`. That is the invariant, and `cors()` in `src/server.js` exists to keep it.

There is one credential: an admin signs in at `/api/admin/login` and the page sends the token it gets back as a bearer header, by hand, on the admin routes. That does not break the invariant, because a browser never sends it on anybody else's behalf, so another origin's script gets exactly what curl gets. A cookie would break it, and `access-control-allow-credentials` must never be set. If either is ever wanted, this header has to name one origin instead.

**The admin whitelist is a list of addresses, not a rule about them.** `src/admin.js` is the copy of record. No domain wildcard. The built-in entry's password ships as an scrypt hash, which keeps the word out of a public history and does not make it secret, so a host sets `BOARD_ADMINS` instead. Sessions are signed rather than stored: no table, no sweep, and changing a password invalidates every token it minted.

**Site statistics are counters, never events.** The board stores a total per UTC day in `stats_days` and a total per day per dimension in `stats_dims`, and that is the finest grain there is: there is no row that describes one visitor, one visit or one lap. No identifier is accepted from a client and none is stored. The country is two letters from the edge, believed only behind `BOARD_TRUST_PROXY`, and nothing here ever looks an address up. New or returning is decided by the browser from a date it keeps for itself and sent as a boolean. Every dimension is a closed list, in `src/validate.js` or in `src/sponsors.js`, which is what stops a stranger with curl growing a table on a public page. The per tab handle that answers "how many are flying now" lives in memory for three minutes and reaches no store. If this ever needs to hold something finer, it needs an argument first and the sentence on the page has to change with it.

**The site icon comes from the simulator's `scripts/icons.js`.** `public/icon.svg`, `public/favicon.ico` and `public/apple-touch-icon.png` are generated output, in mint, which is the colour this page paints a record in. Regenerate, do not edit: `node scripts/icons.js mint ../fdfpv-leaderboard/public` from a checkout of the simulator beside this one.

## Style

- Plain JavaScript. No TypeScript, no framework, no state library.
- Prefer one file doing an obvious thing over three files doing a clever thing.
- No em dashes or en dashes in prose, comments, commit messages or documentation. Use a comma, colon or full stop.
- Long explanatory comments that say why, not what. Match the voice already in `src/server.js` and `public/index.html`.

## Working rules

- `npm test` runs `src/selftest.js` and is cheap. Run it for anything touching the store, the API surface or validation.
- The password behind the shipped admin hash is deliberately not in this repository, so `npm test` cannot check the two against each other. Set `BOARD_SELFTEST_PASSWORD` to check it on a machine where knowing it is fine; the suite says `skip` rather than passing quietly when it is unset.
- **Always ask, before the turn ends, whether to run a verification pass and at what scale.** Somebody looking at the
  real page against the real database learns in one minute what no self test can see, so whether to spend that minute is
  their call and not an assumption. Ask on every turn that changed code, including the turns where `npm test` already
  came back green, because a green check is evidence about the thing it can see and nothing else. Offer the scale
  plainly and let them pick one:
  - **none.** The change is documentation or a comment and there is nothing to look at.
  - **cheap.** `npm test`, seconds of wall clock.
  - **served.** Start the server against a scratch database and fetch the endpoints and the page that changed.
  - **look at it.** Hand it over. Say what to open, what to look for and what would count as wrong.
  The point of asking is that the last one is a real option, and it is often the best one, because this repository's
  whole job is what a visitor sees.
- Never report a check as passing without having run it in the same turn. If a check was not run, say so, say why, and say what was done instead. A green check that cannot see the thing that changed is not evidence either.
- The simulator's `npm run verify` is expensive and does not cover this repository. Do not reach for it here.
- Never change a threshold to make a check pass. Argue for the change instead.

## Review

- **Do not run adversarial review, multi agent review or a review workflow unless directed.** Read your own diff, run the cheap checks, and hand the work over. Fan out only when the request asks for it.
- When a review does run, its findings are written down whether or not they were acted on, and a finding that was declined is recorded with the reason.
