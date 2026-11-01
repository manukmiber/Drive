-- D3 (ADR-086): file request links, through which anyone may only upload into one folder. Kept with
-- the share links in the access database (ADR-064 R0 no. 1); no foreign keys to `nodes` or `users`.
-- `id` is the link's r64, signed like a share link. `drops` are the uploads that came through it,
-- with the uploader's IP as a keyed hash for abuse reports.
CREATE TABLE file_requests (
  id              TEXT PRIMARY KEY,
  created_by      TEXT NOT NULL,
  folder_id       TEXT NOT NULL,
  title           TEXT NOT NULL,
  message         TEXT,
  deadline_at     INTEGER,
  max_files       INTEGER,
  max_file_bytes  INTEGER,
  require_name    INTEGER NOT NULL DEFAULT 0,
  password_hash   TEXT,
  file_count      INTEGER NOT NULL DEFAULT 0,  -- files started through it (a slot each)
  pending_notice  INTEGER NOT NULL DEFAULT 0,  -- files the owner hasn't been told about yet
  revoked_at      INTEGER,
  created_at      INTEGER NOT NULL
);
CREATE INDEX file_requests_creator_idx ON file_requests (created_by, created_at);
CREATE INDEX file_requests_folder_idx ON file_requests (folder_id);
CREATE INDEX file_requests_notice_idx ON file_requests (pending_notice) WHERE pending_notice > 0;

CREATE TABLE file_request_drops (
  upload_id      TEXT PRIMARY KEY,
  request_id     TEXT NOT NULL REFERENCES file_requests (id) ON DELETE CASCADE,
  node_id        TEXT,
  uploader_name  TEXT,
  ip_hash        TEXT NOT NULL,
  size           INTEGER NOT NULL,
  status         TEXT NOT NULL,                -- active | done | aborted
  created_at     INTEGER NOT NULL
);
CREATE INDEX file_request_drops_request_idx ON file_request_drops (request_id, created_at);
