-- ADR-058: a folder's decoration. `decor_color` is a palette name, `decor_icon` an icon name from a fixed
-- list or one emoji, `decor_cover_id` a file node whose thumbnail is the cover. No foreign key on the
-- cover: the image may be trashed, deleted or moved, and the folder then falls back to icon and colour.
ALTER TABLE nodes ADD COLUMN decor_color TEXT;
ALTER TABLE nodes ADD COLUMN decor_icon TEXT;
ALTER TABLE nodes ADD COLUMN decor_cover_id TEXT;
