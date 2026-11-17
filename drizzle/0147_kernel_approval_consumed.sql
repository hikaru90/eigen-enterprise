-- Always-ask tools (ToolDescriptor.approvalAlways): one approval covers exactly one call.
-- The registry consumes the approval (sets consumed_at) in one guarded UPDATE before the tool runs.
ALTER TABLE "kernel_approvals" ADD COLUMN IF NOT EXISTS "consumed_at" timestamp with time zone;
