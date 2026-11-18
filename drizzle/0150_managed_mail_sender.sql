-- eigenEnterprise Mail (plan/managed-mail.md): the default sender of a box in
-- managed mode. owlery_settings holds only the owner's own SES account, so the
-- managed default sender gets its own one-row table.
CREATE TABLE IF NOT EXISTS "managed_mail_sender" (
  "id" text PRIMARY KEY DEFAULT 'managed' NOT NULL,
  "email_from" text NOT NULL,
  "updated_by" text NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
