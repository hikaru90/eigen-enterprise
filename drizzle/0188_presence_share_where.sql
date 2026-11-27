-- "Share where I am" (plan/phase-multiplayer-presence.md): on by default; off = others see the status, never the place.
ALTER TABLE "user_preference" ADD COLUMN IF NOT EXISTS "share_where" boolean NOT NULL DEFAULT true;
