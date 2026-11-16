-- Contact pipeline (Contribute 8c6a0cb7, Ony: "Wir sind dran / Warten auf
-- Antwort / Im Loop halten / Noch nicht angeschrieben"), worked the Getting
-- Things Done way. Every contact sits in exactly one list the person picks —
-- never inferred from text:
--   inbox          = not yet contacted / not processed (Noch nicht angeschrieben)
--   next           = the ball is in our court: a next action (Wir sind dran)
--   waiting        = waiting for their reply, since waiting_since (Warten auf Antwort)
--   keep_in_touch  = keep them in the loop; next_follow_up_on is the tickler (Im Loop halten)
-- owner_id = who on our side holds the contact (Kontakt hält), a company
-- member's user id; via = how we are in touch (Wie); latest_status = where
-- things stand (Letzter Stand). Existing contacts start in the inbox (nobody
-- has placed them yet) and are held by whoever added them.

ALTER TABLE "contacts" ADD COLUMN IF NOT EXISTS "stage" text DEFAULT 'inbox' NOT NULL;
--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN IF NOT EXISTS "owner_id" text;
--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN IF NOT EXISTS "via" text;
--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN IF NOT EXISTS "latest_status" text;
--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN IF NOT EXISTS "waiting_since" date;
--> statement-breakpoint
ALTER TABLE "contacts" DROP CONSTRAINT IF EXISTS "contacts_stage_check";
--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_stage_check" CHECK ("stage" IN ('inbox', 'next', 'waiting', 'keep_in_touch'));
--> statement-breakpoint
ALTER TABLE "contacts" DROP CONSTRAINT IF EXISTS "contacts_via_check";
--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_via_check" CHECK ("via" IS NULL OR "via" IN ('email', 'phone', 'linkedin', 'meeting', 'message', 'other'));
--> statement-breakpoint
ALTER TABLE "contacts" DROP CONSTRAINT IF EXISTS "contacts_latest_status_check";
--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_latest_status_check" CHECK ("latest_status" IS NULL OR length(btrim("latest_status")) BETWEEN 1 AND 500);
--> statement-breakpoint
ALTER TABLE "contacts" DROP CONSTRAINT IF EXISTS "contacts_waiting_since_check";
--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_waiting_since_check" CHECK (("stage" = 'waiting') = ("waiting_since" IS NOT NULL));
--> statement-breakpoint
UPDATE "contacts" SET "owner_id" = "created_by" WHERE "owner_id" IS NULL AND "created_by_kind" = 'user';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "contacts_stage_idx" ON "contacts" ("stage");
