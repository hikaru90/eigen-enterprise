-- When a Drive file is from, as the file itself records it (Contribute 0c945439):
-- the moment a photo was taken (EXIF) or a PDF was created (its Info/XMP
-- metadata), read on upload. Both null when the file records none; Drive then
-- shows when it was uploaded. Files uploaded before this migration stay null.

ALTER TABLE "drive_file" ADD COLUMN IF NOT EXISTS "content_date" timestamp with time zone;
ALTER TABLE "drive_file" ADD COLUMN IF NOT EXISTS "content_date_kind" text;
ALTER TABLE "drive_file" DROP CONSTRAINT IF EXISTS "drive_file_content_date_pair_check";
ALTER TABLE "drive_file" ADD CONSTRAINT "drive_file_content_date_pair_check" CHECK (("content_date" IS NULL) = ("content_date_kind" IS NULL));
ALTER TABLE "drive_file" DROP CONSTRAINT IF EXISTS "drive_file_content_date_kind_check";
ALTER TABLE "drive_file" ADD CONSTRAINT "drive_file_content_date_kind_check" CHECK ("content_date_kind" IS NULL OR "content_date_kind" IN ('taken', 'created'));
