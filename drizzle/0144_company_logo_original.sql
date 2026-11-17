-- The company logo's original and crop (Contribute 8c371cea): a raster logo is
-- zoomed and positioned in Settings → Company; the stored logo is that crop,
-- cut from the uploaded original, which is kept (content-addressed on disk
-- next to the logo) so the crop can be changed later. The crop is a square in
-- the original's pixels: its top-left corner and its size. All five columns
-- are set together, and only with a logo; SVG logos are not cropped (null).

ALTER TABLE "company_profile" ADD COLUMN IF NOT EXISTS "logo_original_sha256" text;
ALTER TABLE "company_profile" ADD COLUMN IF NOT EXISTS "logo_original_mime" text;
ALTER TABLE "company_profile" ADD COLUMN IF NOT EXISTS "logo_crop_left" double precision;
ALTER TABLE "company_profile" ADD COLUMN IF NOT EXISTS "logo_crop_top" double precision;
ALTER TABLE "company_profile" ADD COLUMN IF NOT EXISTS "logo_crop_size" double precision;
ALTER TABLE "company_profile" DROP CONSTRAINT IF EXISTS "company_profile_logo_original_set_check";
ALTER TABLE "company_profile" ADD CONSTRAINT "company_profile_logo_original_set_check" CHECK (
	("logo_original_sha256" IS NULL AND "logo_original_mime" IS NULL AND "logo_crop_left" IS NULL AND "logo_crop_top" IS NULL AND "logo_crop_size" IS NULL)
	OR ("logo_original_sha256" IS NOT NULL AND "logo_original_mime" IS NOT NULL AND "logo_crop_left" IS NOT NULL AND "logo_crop_top" IS NOT NULL AND "logo_crop_size" > 0 AND "logo_sha256" IS NOT NULL)
);
ALTER TABLE "company_profile" DROP CONSTRAINT IF EXISTS "company_profile_logo_original_sha_check";
ALTER TABLE "company_profile" ADD CONSTRAINT "company_profile_logo_original_sha_check" CHECK ("logo_original_sha256" IS NULL OR "logo_original_sha256" ~ '^[0-9a-f]{64}$');
ALTER TABLE "company_profile" DROP CONSTRAINT IF EXISTS "company_profile_logo_original_mime_check";
ALTER TABLE "company_profile" ADD CONSTRAINT "company_profile_logo_original_mime_check" CHECK ("logo_original_mime" IS NULL OR "logo_original_mime" IN ('image/png', 'image/jpeg', 'image/webp'));
