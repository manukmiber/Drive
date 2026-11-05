-- W1e (ADR-099): a Space's files hang from one folder of the main database (nodes.space = 'team'),
-- counted on the team owner's storage until team plans are sold (T6). Which folder is a Space's is
-- "who may open what", so it is kept here beside the Space, never joined with nodes.
ALTER TABLE spaces ADD COLUMN root_node TEXT;
CREATE UNIQUE INDEX spaces_root_node_uq ON spaces (root_node) WHERE root_node IS NOT NULL;
