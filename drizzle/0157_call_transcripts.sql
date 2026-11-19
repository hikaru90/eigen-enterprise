-- Call transcripts (direction agreed 2026-11-19, option A): every browser in a
-- call records its own microphone in ~30 s chunks; each chunk is transcribed
-- (qwen/qwen3-asr-1.7b through the gateway) and stored here as one segment
-- with its speaker and server-side times. The audio itself is never stored.
-- Consent per person: call_participant.transcribe, on by default, switched by
-- that person only. Company-level tables (no RLS), like call: access is
-- decided in the calls service (only people who were in the call read it).

ALTER TABLE "call_participant" ADD COLUMN IF NOT EXISTS "transcribe" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "call_transcript_segment" (
	"seq" bigserial PRIMARY KEY NOT NULL,
	"call_id" uuid NOT NULL REFERENCES "call"("id") ON DELETE CASCADE,
	"speaker_id" text NOT NULL,
	"speaker_kind" text NOT NULL,
	"speaker_name" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone NOT NULL,
	"text" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "call_transcript_segment_kind_check" CHECK ("speaker_kind" IN ('member', 'guest')),
	CONSTRAINT "call_transcript_segment_name_check" CHECK (length("speaker_name") BETWEEN 1 AND 200),
	CONSTRAINT "call_transcript_segment_text_check" CHECK (length("text") BETWEEN 1 AND 20000),
	CONSTRAINT "call_transcript_segment_time_check" CHECK ("ended_at" >= "started_at")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "call_transcript_segment_call_idx" ON "call_transcript_segment" ("call_id", "started_at", "seq");
