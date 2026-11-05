-- W1c (ADR-097): invitations to a team or a Space for an address that has no Zeiko Drive account yet.
-- They wait here, holding the seat (or the guest's place) they were given, until that address signs in
-- to Drive and the invitation becomes a membership, or until it runs out. Beside the memberships it
-- becomes, in the access database (ADR-095).
CREATE TABLE space_invites (
  id          TEXT PRIMARY KEY,
  team_id     TEXT NOT NULL,
  space_id    TEXT,                           -- null: the team itself
  email       TEXT NOT NULL,                  -- lowercase
  role        TEXT NOT NULL,                  -- team: admin | member · Space: guest
  invited_by  TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);
CREATE UNIQUE INDEX space_invites_target_idx ON space_invites (team_id, COALESCE(space_id, ''), email);
CREATE INDEX space_invites_email_idx ON space_invites (email);
