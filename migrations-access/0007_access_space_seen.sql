-- W3/W4 (ADR-096): which Spaces' live rooms a person has been in. A deleted account's messages go
-- from every one of them (T15), including Spaces they left before, and the data export reads them
-- from there. Written by the room on a person's first visit; dropped with the Space.
CREATE TABLE space_seen (
  space_id  TEXT NOT NULL,
  user_id   TEXT NOT NULL,
  first_at  INTEGER NOT NULL,
  PRIMARY KEY (space_id, user_id)
);
CREATE INDEX space_seen_user_idx ON space_seen (user_id);
