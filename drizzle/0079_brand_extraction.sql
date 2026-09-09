-- Visual-brand extraction pipeline (phase-2d M2). Sessions hold a captured
-- site, rounds hold the judge-loop state (facts round 0, candidate rounds 1+),
-- staging holds accepted corpus items until the M3 export/promotion path.

CREATE TABLE IF NOT EXISTS brand_extraction_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  url text NOT NULL,
  title text,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE brand_extraction_sessions
  DROP CONSTRAINT IF EXISTS brand_extraction_sessions_status_check;
ALTER TABLE brand_extraction_sessions
  ADD CONSTRAINT brand_extraction_sessions_status_check CHECK (status IN ('active', 'accepted', 'abandoned'));

CREATE TABLE IF NOT EXISTS brand_extraction_rounds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES brand_extraction_sessions(id) ON DELETE CASCADE,
  round integer NOT NULL,
  digest text NOT NULL,
  screenshot_b64 text NOT NULL,
  candidates jsonb NOT NULL,
  verdict jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, round)
);

CREATE TABLE IF NOT EXISTS brand_corpus_staging (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid REFERENCES brand_extraction_sessions(id) ON DELETE SET NULL,
  name text NOT NULL,
  corpus_item jsonb NOT NULL,
  status text NOT NULL DEFAULT 'staged',
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE brand_corpus_staging
  DROP CONSTRAINT IF EXISTS brand_corpus_staging_status_check;
ALTER TABLE brand_corpus_staging
  ADD CONSTRAINT brand_corpus_staging_status_check CHECK (status IN ('staged', 'exported'));
