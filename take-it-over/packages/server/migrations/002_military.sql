-- Phase C: scheduler, bases, AA, armies, repairs, drones, ships, wars,
-- alliances, notifications, rankings.

-- Durable scheduler. A job runs in the same transaction as its effects, so a
-- crash either commits both or neither; overdue jobs run in run_at order.
CREATE TABLE jobs (
  id          bigserial PRIMARY KEY,
  kind        text NOT NULL,
  ref         text NOT NULL,
  run_at      timestamptz NOT NULL,
  payload     jsonb NOT NULL DEFAULT '{}'::jsonb,
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'cancelled', 'failed')),
  attempts    integer NOT NULL DEFAULT 0,
  last_error  text,
  created_at  timestamptz NOT NULL
);
CREATE INDEX jobs_due_idx ON jobs(run_at, id) WHERE status = 'pending';
CREATE INDEX jobs_ref_idx ON jobs(kind, ref) WHERE status = 'pending';

CREATE TABLE bases (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id    uuid NOT NULL REFERENCES players(id),
  cell_id     bigint NOT NULL UNIQUE,
  lat         double precision NOT NULL,
  lon         double precision NOT NULL,
  created_at  timestamptz NOT NULL
);
CREATE INDEX bases_owner_idx ON bases(owner_id);

CREATE TABLE aa_batteries (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id    uuid NOT NULL REFERENCES players(id),
  cell_id     bigint NOT NULL UNIQUE,
  lat         double precision NOT NULL,
  lon         double precision NOT NULL,
  geog        geography(Point, 4326) NOT NULL,
  created_at  timestamptz NOT NULL
);
CREATE INDEX aa_batteries_geog_idx ON aa_batteries USING gist(geog);
CREATE INDEX aa_batteries_owner_idx ON aa_batteries(owner_id);

CREATE TABLE ships (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id    uuid NOT NULL REFERENCES players(id),
  status      text NOT NULL CHECK (status IN ('idle', 'sailing')),
  lat         double precision NOT NULL,
  lon         double precision NOT NULL,
  route       jsonb,
  depart_at   timestamptz,
  arrive_at   timestamptz,
  created_at  timestamptz NOT NULL
);
CREATE INDEX ships_owner_idx ON ships(owner_id);

CREATE TABLE wars (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  attacker_id  uuid NOT NULL REFERENCES players(id),
  defender_id  uuid NOT NULL REFERENCES players(id),
  sector       bigint[] NOT NULL,
  lat          double precision NOT NULL,
  lon          double precision NOT NULL,
  status       text NOT NULL CHECK (status IN ('active', 'finished')),
  started_at   timestamptz NOT NULL,
  ends_at      timestamptz NOT NULL,
  state        jsonb NOT NULL,
  -- headcount of each army when it joined, for casualty reports
  initial      jsonb NOT NULL DEFAULT '{}'::jsonb,
  winner       text CHECK (winner IN ('attacker', 'defender')),
  outcome      jsonb,
  finished_at  timestamptz
);
CREATE INDEX wars_active_idx ON wars(status) WHERE status = 'active';
CREATE INDEX wars_attacker_idx ON wars(attacker_id);
CREATE INDEX wars_defender_idx ON wars(defender_id);

-- A parcel can be fought over by only one war at a time.
CREATE TABLE war_cells (
  cell_id  bigint PRIMARY KEY,
  war_id   uuid NOT NULL REFERENCES wars(id) ON DELETE CASCADE
);

CREATE TABLE armies (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id     uuid NOT NULL REFERENCES players(id),
  units        jsonb NOT NULL,
  status       text NOT NULL CHECK (status IN ('idle', 'moving', 'at_war', 'repairing', 'sailing', 'retreating')),
  lat          double precision NOT NULL,
  lon          double precision NOT NULL,
  -- movement in progress (moving, retreating, travelling to a war)
  from_lat     double precision,
  from_lon     double precision,
  to_lat       double precision,
  to_lon       double precision,
  depart_at    timestamptz,
  arrive_at    timestamptz,
  -- exclusive assignment: an army fights in at most one war
  war_id       uuid REFERENCES wars(id),
  war_side     text CHECK (war_side IN ('attacker', 'defender')),
  ship_id      uuid REFERENCES ships(id),
  created_at   timestamptz NOT NULL,
  CHECK ((status = 'at_war') = (war_id IS NOT NULL))
);
CREATE INDEX armies_owner_idx ON armies(owner_id);
CREATE INDEX armies_war_idx ON armies(war_id) WHERE war_id IS NOT NULL;
CREATE INDEX armies_pos_idx ON armies(lat, lon);

CREATE TABLE repairs (
  army_id      uuid PRIMARY KEY REFERENCES armies(id) ON DELETE CASCADE,
  base_id      uuid NOT NULL REFERENCES bases(id) ON DELETE CASCADE,
  owner_id     uuid NOT NULL REFERENCES players(id),
  cost         integer NOT NULL,
  started_at   timestamptz NOT NULL,
  finishes_at  timestamptz NOT NULL
);
CREATE INDEX repairs_base_idx ON repairs(base_id);

CREATE TABLE drone_missions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  drone_id      uuid NOT NULL REFERENCES drones(id),
  owner_id      uuid NOT NULL REFERENCES players(id),
  launch_lat    double precision NOT NULL,
  launch_lon    double precision NOT NULL,
  target_lat    double precision NOT NULL,
  target_lon    double precision NOT NULL,
  targets       bigint[] NOT NULL,
  captured      bigint[] NOT NULL DEFAULT '{}',
  launched_at   timestamptz NOT NULL,
  arrive_at     timestamptz NOT NULL,
  return_at     timestamptz NOT NULL,
  status        text NOT NULL CHECK (status IN ('outbound', 'returning', 'completed', 'destroyed')),
  destroyed_at  timestamptz,
  destroyed_by  uuid
);
CREATE INDEX drone_missions_owner_idx ON drone_missions(owner_id, launched_at DESC);
CREATE INDEX drone_missions_active_idx ON drone_missions(status) WHERE status IN ('outbound', 'returning');
CREATE UNIQUE INDEX drone_missions_one_active ON drone_missions(drone_id) WHERE status IN ('outbound', 'returning');

CREATE TABLE alliance_invites (
  alliance_id  uuid NOT NULL REFERENCES alliances(id) ON DELETE CASCADE,
  player_id    uuid NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  invited_by   uuid NOT NULL REFERENCES players(id),
  created_at   timestamptz NOT NULL,
  PRIMARY KEY (alliance_id, player_id)
);

CREATE TABLE notifications (
  id          bigserial PRIMARY KEY,
  player_id   uuid NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  category    text NOT NULL,
  key         text NOT NULL,
  params      jsonb NOT NULL DEFAULT '{}'::jsonb,
  tone        text NOT NULL DEFAULT 'info',
  created_at  timestamptz NOT NULL,
  read_at     timestamptz
);
CREATE INDEX notifications_player_idx ON notifications(player_id, created_at DESC);

ALTER TABLE players
  ADD COLUMN alliance_joined_at timestamptz,
  ADD COLUMN wars_won integer NOT NULL DEFAULT 0,
  ADD COLUMN drone_captures integer NOT NULL DEFAULT 0;
CREATE INDEX players_parcels_rank_idx ON players(parcel_count DESC);
