-- Call lines (plan/video-calls.md §2): when a DM or channel call ends, Calls
-- posts one line into the conversation ("Call, 4 min" / "Missed call") through
-- the composition root. The line is a message whose "call" column carries the
-- structured outcome (empty body) — rendered from data, never parsed from
-- text. One line per call: the unique index makes a second post (another app
-- process, a retried sweep) a no-op. Call lines are always top-level.
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "call" jsonb;
--> statement-breakpoint
ALTER TABLE "messages" DROP CONSTRAINT IF EXISTS "messages_call_shape_check";
--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_call_shape_check" CHECK (
	"call" IS NULL OR (
		jsonb_typeof("call"->'callId') = 'string'
		AND "call"->>'outcome' IN ('ended', 'missed', 'declined')
		AND (("call"->>'outcome' = 'ended') = (jsonb_typeof("call"->'durationSeconds') = 'number'))
		AND "parent_id" IS NULL
	)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "messages_call_id_idx" ON "messages" (("call"->>'callId')) WHERE "call" IS NOT NULL;
