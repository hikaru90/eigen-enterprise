-- Visual brand selection (phase-2d M4, V7): the selection wizard computes the
-- weighted centroid of the picked style cards' vectors and lands the winning
-- corpus design here as a working draft. Activation (draft -> active) is the
-- M5 publish gate. The corpus itself is a static, git-versioned artifact in
-- modules/brand/corpus/ (V2) — source_item_id references it by id, NOT by
-- foreign key: the store/kernel do not own corpus files.

CREATE TABLE IF NOT EXISTS brand_visual_sets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status text NOT NULL DEFAULT 'draft',
  name text NOT NULL,
  source_item_id uuid,
  picked_item_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  seeds jsonb,
  css_vars jsonb NOT NULL,
  dark_css_vars jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE brand_visual_sets
  DROP CONSTRAINT IF EXISTS brand_visual_sets_status_check;
ALTER TABLE brand_visual_sets
  ADD CONSTRAINT brand_visual_sets_status_check CHECK (status IN ('draft', 'active', 'retired'));

-- One active visual set per company: single-tenant kernel tables carry no
-- company_id column (mirrors 0076's per-locale one-active pattern, scoped to
-- the whole instance because the visual identity is global). Draft-only
-- writes are enforced in modules/brand/store.ts (G23: active/retired
-- immutable, fail loud).
CREATE UNIQUE INDEX IF NOT EXISTS brand_visual_sets_one_active
  ON brand_visual_sets (status) WHERE status = 'active';
