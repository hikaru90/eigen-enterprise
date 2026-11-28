CREATE TABLE IF NOT EXISTS "message_mentions" (
	"message_id" uuid NOT NULL REFERENCES "messages"("id") ON DELETE CASCADE,
	"user_id" text NOT NULL,
	CONSTRAINT "message_mentions_pk" PRIMARY KEY ("message_id", "user_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "message_mentions_user_idx" ON "message_mentions" ("user_id");
