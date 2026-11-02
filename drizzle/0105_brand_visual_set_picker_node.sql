-- Brand picker (plan/phase-brand-picker.md §3.3): a visual set chosen in the
-- picker records the taxonomy node it came from. The taxonomy is a static,
-- in-repo index (modules/brand/taxonomy) — referenced by id, no FK. Wizard and
-- extract sets keep picker_node_id NULL.

ALTER TABLE brand_visual_sets
  ADD COLUMN picker_node_id text;
