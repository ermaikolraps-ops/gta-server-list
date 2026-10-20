-- Phase A: players, sessions, economy, territory, GPS anti-cheat, land mask.
-- All timestamps are written by the application clock (not now()) so that the
-- game is deterministic under test and survives clock-skewed replicas.

CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE players (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username            text NOT NULL,
  username_lower      text NOT NULL UNIQUE,
  password_hash       text NOT NULL,
  color               text NOT NULL CHECK (color ~ '^#[0-9a-f]{6}$'),
  locale              text NOT NULL DEFAULT 'en' CHECK (locale IN ('en', 'es')),
  -- Credits in units of 1/3,600,000 credit (one parcel-millisecond). See shared/economy.ts.
  credit_units        bigint NOT NULL CHECK (credit_units >= 0),
  parcel_count        integer NOT NULL DEFAULT 0 CHECK (parcel_count >= 0),
  settled_at          timestamptz NOT NULL,
  gps_suspended_until timestamptz,
  notification_prefs  jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at          timestamptz NOT NULL
);

CREATE TABLE sessions (
  token_hash   bytea PRIMARY KEY,
  player_id    uuid NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL,
  expires_at   timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL
);
CREATE INDEX sessions_player_idx ON sessions(player_id);

-- Only owned parcels are stored; every absent land cell is neutral.
CREATE TABLE parcels (
  cell_id      bigint PRIMARY KEY CHECK (cell_id >= 0),
  owner_id     uuid NOT NULL REFERENCES players(id),
  -- 0.1° zone of the cell centre, for zoomed-out aggregation.
  zlat         smallint NOT NULL,
  zlon         smallint NOT NULL,
  acquired_at  timestamptz NOT NULL,
  acquired_via text NOT NULL CHECK (acquired_via IN ('gps', 'drone', 'war'))
);
CREATE INDEX parcels_owner_idx ON parcels(owner_id);
CREATE INDEX parcels_zone_idx ON parcels(zlat, zlon);

-- Audit trail of every credit movement except passive income.
CREATE TABLE ledger (
  id          bigserial PRIMARY KEY,
  player_id   uuid NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  delta_units bigint NOT NULL,
  reason      text NOT NULL,
  ref         text,
  created_at  timestamptz NOT NULL
);
CREATE INDEX ledger_player_idx ON ledger(player_id, created_at);

CREATE TABLE idempotency_keys (
  player_id   uuid NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  key         text NOT NULL,
  route       text NOT NULL,
  status_code integer NOT NULL,
  response    jsonb NOT NULL,
  created_at  timestamptz NOT NULL,
  PRIMARY KEY (player_id, key)
);

-- GPS anomalies keep derived numbers (speed, distance, cell ids), never a
-- coordinate trail.
CREATE TABLE gps_anomalies (
  id         bigserial PRIMARY KEY,
  player_id  uuid NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  kind       text NOT NULL,
  detail     jsonb NOT NULL,
  created_at timestamptz NOT NULL
);
CREATE INDEX gps_anomalies_player_idx ON gps_anomalies(player_id, created_at);

-- Coarse 0.1° zones a territory-less player has explored (exploration rewards).
CREATE TABLE explored_zones (
  player_id  uuid NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  zone       integer NOT NULL,
  first_at   timestamptz NOT NULL,
  rewarded   boolean NOT NULL,
  PRIMARY KEY (player_id, zone)
);

CREATE TABLE drones (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id    uuid NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  type        text NOT NULL CHECK (type IN ('basic', 'advanced', 'longRange')),
  status      text NOT NULL CHECK (status IN ('idle', 'flying', 'destroyed')),
  created_at  timestamptz NOT NULL
);
CREATE INDEX drones_owner_idx ON drones(owner_id);

-- Land mask: land polygons minus inland water, subdivided for fast lookups.
CREATE TABLE land_polygons (
  id     serial PRIMARY KEY,
  source text NOT NULL,
  geom   geometry(Polygon, 4326) NOT NULL
);
CREATE INDEX land_polygons_geom_idx ON land_polygons USING gist(geom);

CREATE TABLE water_polygons (
  id     serial PRIMARY KEY,
  source text NOT NULL,
  geom   geometry(Polygon, 4326) NOT NULL
);
CREATE INDEX water_polygons_geom_idx ON water_polygons USING gist(geom);

-- Alliances are part of the core schema because the public map colours
-- territory by alliance when zoomed out.
CREATE TABLE alliances (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  name_lower  text NOT NULL UNIQUE,
  color       text NOT NULL CHECK (color ~ '^#[0-9a-f]{6}$'),
  leader_id   uuid NOT NULL REFERENCES players(id),
  created_at  timestamptz NOT NULL
);
ALTER TABLE players ADD COLUMN alliance_id uuid REFERENCES alliances(id) ON DELETE SET NULL;
CREATE INDEX players_alliance_idx ON players(alliance_id);
