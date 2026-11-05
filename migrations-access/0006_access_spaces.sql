-- W1 (ADR-095): Zeiko Spaces' teams and their Spaces. Who belongs where is "who may open what", so it
-- lives beside person shares (ADR-085) in the access database, never in the main D1 (ADR-064). The
-- plan numbers on a team (seats, Spaces, guests per Space, status) are a copy: the config's defaults
-- when the team is made, and the relay's once team plans are sold. No foreign keys to `users`:
-- code removes rows when an account goes (services/spaces.ts).
CREATE TABLE teams (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  owner_id    TEXT NOT NULL,
  seats       INTEGER NOT NULL,               -- team members, the owner included
  max_spaces  INTEGER NOT NULL,
  max_guests  INTEGER NOT NULL,               -- per Space
  status      TEXT NOT NULL DEFAULT 'active', -- active | readonly | frozen
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX teams_owner_idx ON teams (owner_id);

-- One row per seat. The owner is a row too (role 'owner').
CREATE TABLE team_members (
  team_id    TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  role       TEXT NOT NULL,                   -- owner | admin | member
  added_by   TEXT NOT NULL,
  joined_at  INTEGER NOT NULL,
  PRIMARY KEY (team_id, user_id)
);
CREATE INDEX team_members_user_idx ON team_members (user_id);

CREATE TABLE spaces (
  id          TEXT PRIMARY KEY,
  team_id     TEXT NOT NULL,
  name        TEXT NOT NULL,
  created_by  TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX spaces_team_idx ON spaces (team_id);

-- Who is in a Space besides the team's owner and admins, who are in every Space of their team
-- without a row. A team member is 'member'; anyone else is 'guest' and takes no seat.
CREATE TABLE space_members (
  space_id  TEXT NOT NULL,
  user_id   TEXT NOT NULL,
  role      TEXT NOT NULL,                    -- member | guest
  added_by  TEXT NOT NULL,
  added_at  INTEGER NOT NULL,
  PRIMARY KEY (space_id, user_id)
);
CREATE INDEX space_members_user_idx ON space_members (user_id);
