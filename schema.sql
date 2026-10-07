-- This file is part of the Paraguayan Drone Combat Simulator.
--
-- The Paraguayan Drone Combat Simulator is free software: you can redistribute it and/or modify
-- it under the terms of the GNU General Public License as published by
-- the Free Software Foundation, either version 3 of the License, or (at
-- your option) any later version.
--
-- The Paraguayan Drone Combat Simulator is distributed in the hope that it will be useful, but
-- WITHOUT ANY WARRANTY, without even the implied warranty of
-- MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
-- General Public License for more details.
--
-- You should have received a copy of the GNU General Public License
-- along with the Paraguayan Drone Combat Simulator. If not, see <https://www.gnu.org/licenses/>.

-- ====================================================================
-- The board's Postgres schema, applied by src/store.js on every start.
--
-- It only ever adds: every statement is IF NOT EXISTS, so a database of
-- any age catches up when the board restarts and nothing already stored
-- is rewritten. A new column is an ALTER TABLE ... ADD COLUMN IF NOT
-- EXISTS after the CREATE that predates it, never an edit to that
-- CREATE, because CREATE TABLE IF NOT EXISTS does nothing on a table that
-- is already there. Keep the statements in this order: a fresh database
-- gets its columns in the order the live one grew them.
-- ====================================================================

-- One row per published track. The document is kept whole, logos and
-- all, so a track flown from the board looks as its author published it.
-- `plan` is written for the record but never read back: the card's plan
-- is drawn from the document every time. The class, the world and the
-- designer have no columns for the same reason.
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

-- One row per posted time; a removed track takes its times with it.
-- `public_id` (tm-xxxxxxxx) is how the API names a time, minted by the
-- store, since the serial is storage and the file store has none.
-- `ghost` is the recorded lap in the simulator's ghost format, base64.
CREATE TABLE IF NOT EXISTS times (
  id BIGSERIAL PRIMARY KEY,
  track_id TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  public_id TEXT,
  name TEXT NOT NULL,
  lap_ms INTEGER NOT NULL,
  ghost TEXT,
  posted_utc TIMESTAMPTZ NOT NULL
);

-- Databases from before ghosts gain both columns here; their old rows
-- read null, which the API serves as "no ghost".
ALTER TABLE times ADD COLUMN IF NOT EXISTS public_id TEXT;
ALTER TABLE times ADD COLUMN IF NOT EXISTS ghost TEXT;

-- The run's best three consecutive laps in ms, which a room is scored on.
-- Null is not nought: it is a run without three clean laps, or a row from
-- before the column, and the page prints nothing for it.
ALTER TABLE times ADD COLUMN IF NOT EXISTS three_ms INTEGER;

-- The pilot key that signed the time.
ALTER TABLE times ADD COLUMN IF NOT EXISTS pilot_key TEXT;

-- Which key owns a name: the first to post under it. `name_key` is the
-- name lower cased, `name` as the pilot typed it.
CREATE TABLE IF NOT EXISTS pilots (
  name_key TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  public_key TEXT NOT NULL,
  claimed_utc TIMESTAMPTZ NOT NULL
);

-- The fixed wing a plane's lap on a world track was flown on (an airframe
-- id the lap check accepted), null on every other time. A time naming one
-- is on that track's plane board; rows from before stay where they were.
ALTER TABLE times ADD COLUMN IF NOT EXISTS craft TEXT;

-- A track's times in the order the board ranks them: fastest, then
-- earliest.
CREATE INDEX IF NOT EXISTS times_track_lap
  ON times (track_id, lap_ms, posted_utc);

CREATE UNIQUE INDEX IF NOT EXISTS times_public_id
  ON times (public_id);

-- What testers file from the simulator: bug reports and flight feel
-- feedback, told apart by `kind`.
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

-- A ticket's screenshots, up to four, each fetched alone by (bug_id, n),
-- so listing or opening tickets never reads an image. `type` is what
-- src/validate.js read off the bytes, never what the sender claimed; the
-- size limits live there too.
CREATE TABLE IF NOT EXISTS bug_images (
  bug_id TEXT NOT NULL REFERENCES bugs(id) ON DELETE CASCADE,
  n SMALLINT NOT NULL CHECK (n BETWEEN 1 AND 4),
  type TEXT NOT NULL,
  bytes BYTEA NOT NULL,
  PRIMARY KEY (bug_id, n)
);

-- A track's tags, at most five from a closed list. An array rather than a
-- join table: nothing asks which tracks wear a tag except the filter, and
-- the GIN index answers that. Existing rows read as untagged.
ALTER TABLE tracks ADD COLUMN IF NOT EXISTS tags TEXT[] NOT NULL DEFAULT '{}';

CREATE INDEX IF NOT EXISTS tracks_tags ON tracks USING GIN (tags);

-- The page filters by who built a track.
CREATE INDEX IF NOT EXISTS tracks_author ON tracks (lower(author));

-- Freestyle runs: each pilot's best run per map and nothing else. Every
-- number in a row is the posting page's claim, bounded by inspectRun in
-- src/validate.js and never recomputed.
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

-- Highest score first, earlier post first on a tie, as src/store.js
-- ranks them.
CREATE INDEX IF NOT EXISTS runs_map_score
  ON runs (map, score DESC, posted_utc);

CREATE UNIQUE INDEX IF NOT EXISTS runs_public_id
  ON runs (public_id);

-- One row per pilot per map, compared without case: what the store's
-- replace-if-better upsert conflicts on.
CREATE UNIQUE INDEX IF NOT EXISTS runs_pilot_map
  ON runs (map, lower(name));

-- A room's card animation, uploaded finished by the simulator's builder
-- and served as bytes; null until there is one. Only rooms may carry one,
-- a rule inspectGif reads off the stored document, which a CHECK here
-- could not see into.
ALTER TABLE tracks ADD COLUMN IF NOT EXISTS gif BYTEA;
ALTER TABLE tracks ADD COLUMN IF NOT EXISTS gif_utc TIMESTAMPTZ;

-- ====================================================================
-- Site statistics: counters, never events. Every write adds to a total
-- for a UTC day, so the finest thing these tables can answer is "this
-- many, that day". No address, identifier, agent or time finer than a day
-- is in them, and no row is about one visitor.
-- ====================================================================

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

-- One row per day per dimension value, such as (day, 'country', 'AU').
-- Every key comes from a closed list (src/validate.js, src/sponsors.js)
-- and unknown values fold before writing, so a stranger cannot grow this
-- table. The primary key leads on the day, which is the range every read
-- asks for, so no second index is needed.
CREATE TABLE IF NOT EXISTS stats_dims (
  day DATE NOT NULL,
  dim TEXT NOT NULL,
  key TEXT NOT NULL,
  visits INTEGER NOT NULL DEFAULT 0,
  sessions INTEGER NOT NULL DEFAULT 0,
  laps INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, dim, key)
);
