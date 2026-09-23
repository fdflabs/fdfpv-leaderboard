-- This file is part of the WebFPVSimulator leaderboard.
--
-- This program is free software: you can redistribute it and/or modify
-- it under the terms of the GNU General Public License as published by
-- the Free Software Foundation, either version 3 of the License, or (at
-- your option) any later version.
--
-- This program is distributed in the hope that it will be useful, but
-- WITHOUT ANY WARRANTY, without even the implied warranty of
-- MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
-- General Public License for more details.
--
-- You should have received a copy of the GNU General Public License
-- along with this program. If not, see <https://www.gnu.org/licenses/>.

-- Public board. One row per published course, one row per posted time.
-- The track document is stored whole, logo included, so a course flown
-- from this board wears the same sponsor print the author published.

CREATE TABLE IF NOT EXISTS tracks (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  author TEXT NOT NULL,
  document JSONB NOT NULL,
  plan JSONB NOT NULL,
  layout_hash TEXT NOT NULL,
  edit_key_hash TEXT NOT NULL,
  has_logo BOOLEAN NOT NULL DEFAULT FALSE,
  gates INTEGER NOT NULL,
  elements INTEGER NOT NULL,
  published_utc TIMESTAMPTZ NOT NULL,
  updated_utc TIMESTAMPTZ NOT NULL
);

-- public_id is the handle a time is addressed by over the API, minted by
-- the store like a bug id, because the BIGSERIAL is a storage detail and
-- the file store has no serial to match it with. ghost is the simulator's
-- recorded lap for that time, base64 of the format in the simulator's
-- src/share/ghostdata.js, and null on a time posted without one.
CREATE TABLE IF NOT EXISTS times (
  id BIGSERIAL PRIMARY KEY,
  track_id TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  public_id TEXT,
  name TEXT NOT NULL,
  lap_ms INTEGER NOT NULL,
  ghost TEXT,
  posted_utc TIMESTAMPTZ NOT NULL
);

-- Additive migration for a database from before ghosts. CREATE TABLE IF
-- NOT EXISTS above does nothing on an existing table, so the two columns
-- are added here as well; rows from before carry null in both, which the
-- API reads as "no ghost to fetch".
ALTER TABLE times ADD COLUMN IF NOT EXISTS public_id TEXT;
ALTER TABLE times ADD COLUMN IF NOT EXISTS ghost TEXT;

-- The fastest three CONSECUTIVE laps of the run that set this time, in
-- milliseconds, and null on every row posted before it existed.
--
-- RaceGOW is scored on three consecutive laps where MultiGP's time trial is
-- scored on one, so a time flown in a room carries both numbers and a time
-- flown on the field carries the lap alone. Null is not "nought": it is a
-- run that never put three clean laps together, and the board prints nothing
-- rather than a zero.
--
-- There is deliberately NO column for the track class. A track's class is
-- read off its stored document by trackClassOf in src/validate.js, on every
-- list, exactly as the plan is: one copy of the truth and no migration to
-- get wrong.
ALTER TABLE times ADD COLUMN IF NOT EXISTS three_ms INTEGER;
ALTER TABLE times ADD COLUMN IF NOT EXISTS pilot_key TEXT;
-- A name belongs to the first pilot key that posted under it. name_key is
-- the name lowercased; name keeps the case the pilot typed.
CREATE TABLE IF NOT EXISTS pilots (
  name_key TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  public_key TEXT NOT NULL,
  claimed_utc TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS times_track_lap
  ON times (track_id, lap_ms, posted_utc);

CREATE UNIQUE INDEX IF NOT EXISTS times_public_id
  ON times (public_id);

-- Tester tickets from the simulator. Additive: an existing database
-- gains this table the next time the process starts, and nothing in
-- tracks or times is rewritten.
CREATE TABLE IF NOT EXISTS bugs (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  what TEXT NOT NULL,
  expected TEXT NOT NULL DEFAULT '',
  steps TEXT NOT NULL DEFAULT '',
  reporter TEXT NOT NULL,
  context JSONB NOT NULL DEFAULT '{}'::jsonb,
  resolution TEXT NOT NULL DEFAULT '',
  submitted_utc TIMESTAMPTZ NOT NULL,
  updated_utc TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS bugs_status_submitted
  ON bugs (status, submitted_utc DESC);

-- Tags on a track. Additive: an existing row gets the empty array, which
-- reads as "untagged" everywhere. TEXT[] rather than a join table because a
-- track wears at most five of a closed vocabulary and nothing ever asks the
-- question the other way round, which is the only thing a join table would
-- buy. The GIN index is what makes "every track tagged skills" a lookup
-- rather than a scan of the whole board.
ALTER TABLE tracks ADD COLUMN IF NOT EXISTS tags TEXT[] NOT NULL DEFAULT '{}';

CREATE INDEX IF NOT EXISTS tracks_tags ON tracks USING GIN (tags);

-- Filtering by author is a first class thing on the board page now, and
-- author has always been a column. It only ever lacked an index.
CREATE INDEX IF NOT EXISTS tracks_author ON tracks (lower(author));

-- Freestyle runs. One row per posted run, and the board keeps only a
-- pilot's BEST run per map: a leaderboard is a list of who is good, not a
-- log of who pressed the button. public_id is minted by the store like a
-- time id, for the same reason.
--
-- Every number here is CLAIMED by the page that posted it. The board cannot
-- recompute a score without being a second copy of the game, so validate.js
-- bounds the claim and checks it against itself and nothing here should be
-- read as verified. See inspectRun.
CREATE TABLE IF NOT EXISTS runs (
  id BIGSERIAL PRIMARY KEY,
  public_id TEXT,
  name TEXT NOT NULL,
  map TEXT NOT NULL,
  style TEXT NOT NULL,
  score INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  tricks INTEGER NOT NULL,
  unique_tricks INTEGER NOT NULL,
  best_combo INTEGER NOT NULL,
  best_trick INTEGER NOT NULL,
  crashes INTEGER NOT NULL,
  signature TEXT NOT NULL DEFAULT '',
  posted_utc TIMESTAMPTZ NOT NULL
);

-- The ordering rule, in SQL. It has to agree with byScore in src/store.js:
-- highest score, then the earlier post, so a pilot who ties does not take
-- the place off the pilot who got there first.
CREATE INDEX IF NOT EXISTS runs_map_score
  ON runs (map, score DESC, posted_utc);

CREATE UNIQUE INDEX IF NOT EXISTS runs_public_id
  ON runs (public_id);

-- One row per pilot per map, which is what makes the replace-if-better
-- write safe to do as an upsert. lower(name) so a pilot who capitalises
-- differently on Tuesday does not get a second row.
CREATE UNIQUE INDEX IF NOT EXISTS runs_pilot_map
  ON runs (map, lower(name));

-- The card animation: one lap of the track, drawn by the simulator's own
-- src/trackbuilder/animate.js and uploaded here as a finished GIF. The board
-- renders nothing, so this is storage and not a picture being made.
--
-- Only a RaceGOW room carries one, and that rule lives in inspectGif in
-- src/validate.js rather than in a constraint here, because it is read off
-- the stored document's class and a CHECK cannot see into JSONB without
-- being a second copy of trackClassOf. A field track's plan is worth
-- drawing and public/plan.js draws it for nothing; a room's plan is an
-- almost empty rectangle.
--
-- BYTEA rather than base64 in a TEXT column: a GIF is bytes, the API serves
-- it as bytes, and base64 would be a third more of them for nothing. Null
-- means no animation, which is every row until one is uploaded.
ALTER TABLE tracks ADD COLUMN IF NOT EXISTS gif BYTEA;
ALTER TABLE tracks ADD COLUMN IF NOT EXISTS gif_utc TIMESTAMPTZ;

-- ------------------------------------------------------------------
-- Site statistics. COUNTERS, NEVER EVENTS.
-- ------------------------------------------------------------------
--
-- There is no row here that describes one person, one visit or one lap.
-- Every write adds to a total that already existed, so the finest grain
-- this database holds is "on this UTC day, this many". That is not a
-- privacy policy written next to a table that could answer a different
-- question; it is the table being unable to answer it.
--
-- No address, no identifier, no user agent, no session row, no timestamp
-- finer than a day. The country is two letters handed over by the edge in
-- front of the site and nothing here ever looks one up. The browser that
-- sends an event decides whether it is new or returning, from a date it
-- keeps for itself, and sends the ANSWER rather than the date.
--
-- Additive: an existing database gains these the next time the process
-- starts, and nothing in tracks, times, runs or bugs is rewritten.

CREATE TABLE IF NOT EXISTS stats_days (
  day DATE PRIMARY KEY,
  visits INTEGER NOT NULL DEFAULT 0,
  new_visitors INTEGER NOT NULL DEFAULT 0,
  returning_visitors INTEGER NOT NULL DEFAULT 0,
  sessions INTEGER NOT NULL DEFAULT 0,
  laps INTEGER NOT NULL DEFAULT 0,
  flight_s BIGINT NOT NULL DEFAULT 0,
  crashes INTEGER NOT NULL DEFAULT 0
);

-- One row per day per dimension value: (day, 'country', 'AU'), (day,
-- 'craft', '5inch'), and so on. A wide table with a column per country was
-- the alternative and it is a migration every time the world changes.
--
-- Every `key` comes from a CLOSED vocabulary in src/validate.js or from the
-- sponsor list in src/sponsors.js, so this table cannot be grown by a
-- stranger inventing values: an unknown source folds into 'other' and an
-- unknown country into 'ZZ' before anything is written.
CREATE TABLE IF NOT EXISTS stats_dims (
  day DATE NOT NULL,
  dim TEXT NOT NULL,
  key TEXT NOT NULL,
  visits INTEGER NOT NULL DEFAULT 0,
  sessions INTEGER NOT NULL DEFAULT 0,
  laps INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, dim, key)
);

-- No second index. The primary key leads on day, so the thirty day window
-- the page reads is a range scan over the key that already exists, and a
-- separate index on day would be a copy of its first column.
