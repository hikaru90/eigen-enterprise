-- plan/phase-platform.md step 1: module merge, no behaviour change.
-- website = website + substrate + github; email = email + owlery;
-- orchestrator (internal) = repo + dev-agent + roadmap. A merged module is
-- active if any of its parts was; it gets a row only if a part had one.
-- Tool names are unchanged (merged modules own the old ids as namespaces).
-- Generated from src/lib/kernel/module-merge.ts and pinned by its spec.
INSERT INTO "kernel_module_activations" ("module_id", "active", "updated_at")
SELECT 'website', bool_or("active"), now() FROM "kernel_module_activations"
WHERE "module_id" IN ('website', 'substrate', 'github')
HAVING count(*) > 0
ON CONFLICT ("module_id") DO UPDATE SET "active" = EXCLUDED."active", "updated_at" = EXCLUDED."updated_at";
--> statement-breakpoint
INSERT INTO "kernel_module_activations" ("module_id", "active", "updated_at")
SELECT 'email', bool_or("active"), now() FROM "kernel_module_activations"
WHERE "module_id" IN ('email', 'owlery')
HAVING count(*) > 0
ON CONFLICT ("module_id") DO UPDATE SET "active" = EXCLUDED."active", "updated_at" = EXCLUDED."updated_at";
--> statement-breakpoint
INSERT INTO "kernel_module_activations" ("module_id", "active", "updated_at")
SELECT 'orchestrator', bool_or("active"), now() FROM "kernel_module_activations"
WHERE "module_id" IN ('repo', 'dev-agent', 'roadmap')
HAVING count(*) > 0
ON CONFLICT ("module_id") DO UPDATE SET "active" = EXCLUDED."active", "updated_at" = EXCLUDED."updated_at";
--> statement-breakpoint
DELETE FROM "kernel_module_activations" WHERE "module_id" IN ('substrate', 'github', 'owlery', 'repo', 'dev-agent', 'roadmap');
