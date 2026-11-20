-- Drive source folders (plan/github-drive-full-mirror.md §5): list and remove
-- select a source's keys by prefix (`external_key LIKE 'repo:1/%'`). The
-- primary key's collation index can't serve LIKE; text_pattern_ops can.
CREATE INDEX IF NOT EXISTS "drive_source_items_key_prefix_idx" ON "drive_source_items" ("source", "external_key" text_pattern_ops);
