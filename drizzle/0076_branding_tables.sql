-- Brand kernel tables (phase-2c) — the company's brand as executable context.
-- Ruleset of record: plan/branding-module-rules.md (G1–G25); phase plan:
-- plan/phase-2c-branding-module.md. Guideline sets are immutable versions
-- (draft -> active -> retired); child curation tables hang off a set and are
-- only writable while it is a draft (enforced in modules/brand/store.ts).

CREATE TABLE IF NOT EXISTS brand_guideline_sets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version integer NOT NULL,
  locale text NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  context jsonb NOT NULL,
  base_set_id uuid,
  activated_at timestamptz,
  validation_run_id uuid,
  event_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- One active set per locale (D3): resolution is by explicit locale, never an
-- implicit "latest" (G23). App-level CHECK constraints survive dump/restore
-- better than enum churn (repo idiom, see 0075).
CREATE UNIQUE INDEX IF NOT EXISTS brand_guideline_sets_one_active_per_locale
  ON brand_guideline_sets (locale) WHERE status = 'active';
ALTER TABLE brand_guideline_sets
  DROP CONSTRAINT IF EXISTS brand_guideline_sets_status_check;
ALTER TABLE brand_guideline_sets
  ADD CONSTRAINT brand_guideline_sets_status_check CHECK (status IN ('draft', 'active', 'retired'));

-- G2: voice is stored as exemplars first (good/bad pairs), tone adjectives second.
CREATE TABLE IF NOT EXISTS brand_voice_examples (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  set_id uuid NOT NULL REFERENCES brand_guideline_sets(id) ON DELETE CASCADE,
  content_type text NOT NULL,
  situation text,
  body text NOT NULL,
  label text NOT NULL,
  rationale text
);
ALTER TABLE brand_voice_examples
  DROP CONSTRAINT IF EXISTS brand_voice_examples_label_check;
ALTER TABLE brand_voice_examples
  ADD CONSTRAINT brand_voice_examples_label_check CHECK (label IN ('good', 'bad'));
ALTER TABLE brand_voice_examples
  ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();

-- G1: lexicon as machine-readable allowed/banned/required terms.
CREATE TABLE IF NOT EXISTS brand_lexicon (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  set_id uuid NOT NULL REFERENCES brand_guideline_sets(id) ON DELETE CASCADE,
  term text NOT NULL,
  kind text NOT NULL,
  context_key text,
  replacement text,
  UNIQUE (set_id, term)
);
ALTER TABLE brand_lexicon
  DROP CONSTRAINT IF EXISTS brand_lexicon_kind_check;
ALTER TABLE brand_lexicon
  ADD CONSTRAINT brand_lexicon_kind_check CHECK (kind IN ('allowed', 'banned', 'required'));

-- G5: visual identity as named vocabulary + tokens (owlery bootstraps later, D1).
CREATE TABLE IF NOT EXISTS brand_visual_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  set_id uuid NOT NULL REFERENCES brand_guideline_sets(id) ON DELETE CASCADE,
  token text NOT NULL,
  value text NOT NULL,
  prose_rationale text,
  style_vocabulary jsonb NOT NULL DEFAULT '[]'::jsonb,
  UNIQUE (set_id, token)
);

CREATE TABLE IF NOT EXISTS brand_glossary (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  set_id uuid NOT NULL REFERENCES brand_guideline_sets(id) ON DELETE CASCADE,
  term text NOT NULL,
  definition text NOT NULL,
  usage_note text,
  UNIQUE (set_id, term)
);

-- G10/G16: per-content-type validation criteria with risk tiers.
CREATE TABLE IF NOT EXISTS brand_criteria (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  set_id uuid NOT NULL REFERENCES brand_guideline_sets(id) ON DELETE CASCADE,
  content_type text NOT NULL,
  criterion text NOT NULL,
  kind text NOT NULL,
  spec jsonb NOT NULL,
  risk_tier text NOT NULL DEFAULT 'standard',
  UNIQUE (set_id, content_type, criterion)
);
ALTER TABLE brand_criteria
  DROP CONSTRAINT IF EXISTS brand_criteria_kind_check;
ALTER TABLE brand_criteria
  ADD CONSTRAINT brand_criteria_kind_check CHECK (kind IN ('deterministic', 'judge'));
ALTER TABLE brand_criteria
  DROP CONSTRAINT IF EXISTS brand_criteria_risk_tier_check;
ALTER TABLE brand_criteria
  ADD CONSTRAINT brand_criteria_risk_tier_check CHECK (risk_tier IN ('low', 'standard', 'heritage'));

-- G6/G20/D4: every asset is a draft with full provenance until a human publishes.
CREATE TABLE IF NOT EXISTS brand_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  content_type text NOT NULL,
  locale text NOT NULL,
  body text NOT NULL,
  risk_tier text NOT NULL DEFAULT 'standard',
  guideline_set_id uuid NOT NULL REFERENCES brand_guideline_sets(id),
  provenance jsonb NOT NULL DEFAULT '{}'::jsonb,
  disclosure text NOT NULL DEFAULT 'ai_assisted',
  status text NOT NULL DEFAULT 'draft',
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE brand_assets
  DROP CONSTRAINT IF EXISTS brand_assets_risk_tier_check;
ALTER TABLE brand_assets
  ADD CONSTRAINT brand_assets_risk_tier_check CHECK (risk_tier IN ('low', 'standard', 'heritage'));
ALTER TABLE brand_assets
  DROP CONSTRAINT IF EXISTS brand_assets_disclosure_check;
ALTER TABLE brand_assets
  ADD CONSTRAINT brand_assets_disclosure_check CHECK (disclosure IN ('ai_assisted', 'human_authored'));
ALTER TABLE brand_assets
  DROP CONSTRAINT IF EXISTS brand_assets_status_check;
ALTER TABLE brand_assets
  ADD CONSTRAINT brand_assets_status_check CHECK (status IN ('draft', 'validated', 'published', 'rejected'));

-- G11/G12: per-criterion validation records (deterministic + judge layers).
CREATE TABLE IF NOT EXISTS brand_validations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id uuid NOT NULL REFERENCES brand_assets(id) ON DELETE CASCADE,
  layer text NOT NULL,
  criterion text NOT NULL,
  result text NOT NULL,
  rationale text,
  judge_id text,
  judge_model text,
  judge_metrics_ref uuid
);
ALTER TABLE brand_validations
  DROP CONSTRAINT IF EXISTS brand_validations_layer_check;
ALTER TABLE brand_validations
  ADD CONSTRAINT brand_validations_layer_check CHECK (layer IN ('deterministic', 'judge'));
ALTER TABLE brand_validations
  DROP CONSTRAINT IF EXISTS brand_validations_result_check;
ALTER TABLE brand_validations
  ADD CONSTRAINT brand_validations_result_check CHECK (result IN ('pass', 'fail', 'flag'));

-- G12/G24: measured judge accuracy per guideline-set version + judge identity.
CREATE TABLE IF NOT EXISTS brand_judge_metrics (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  set_id uuid NOT NULL REFERENCES brand_guideline_sets(id) ON DELETE CASCADE,
  judge_id text NOT NULL,
  judge_model text NOT NULL,
  f1 real NOT NULL,
  precision real NOT NULL,
  recall real NOT NULL,
  calibration_set_ref text NOT NULL,
  measured_at timestamptz NOT NULL DEFAULT now()
);

-- G12: human-annotated calibration cases are first-class data.
CREATE TABLE IF NOT EXISTS brand_calibration_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  set_id uuid NOT NULL REFERENCES brand_guideline_sets(id) ON DELETE CASCADE,
  content_type text NOT NULL,
  body text NOT NULL,
  expected jsonb NOT NULL,
  annotated_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
