-- Polish 1 P-5: every person has a complete profile — first name, last name and
-- a profile picture. The names already live on "user" (first_name / last_name,
-- 0068; name = "First Last"). The picture is a 256 px WebP stored
-- content-addressed next to the Drive's blobs (its own namespace, so the
-- Drive's unused-blob cleanup never touches it); avatar_sha256 names those
-- bytes and "user".image is the authenticated route that serves them
-- (/api/people/avatar/<sha256>). NULL = no picture yet: the profile step asks.

ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "avatar_sha256" text;

ALTER TABLE "user" DROP CONSTRAINT IF EXISTS "user_avatar_sha256_hex";
ALTER TABLE "user" ADD CONSTRAINT "user_avatar_sha256_hex"
  CHECK ("avatar_sha256" IS NULL OR "avatar_sha256" ~ '^[0-9a-f]{64}$');

CREATE INDEX IF NOT EXISTS "user_avatar_sha256_idx" ON "user" ("avatar_sha256") WHERE "avatar_sha256" IS NOT NULL;

-- Existing people: name parts from the account name where they were never
-- split (first token = first name, the rest = last name — the split signup
-- uses). The profile step pre-fills them; the person confirms or corrects.
UPDATE "user"
SET
  "first_name" = substring(btrim("name") from '^\S+'),
  "last_name" = nullif(btrim(substring(btrim("name") from '^\S+\s+(.*)$')), '')
WHERE "first_name" IS NULL AND btrim("name") <> '';
