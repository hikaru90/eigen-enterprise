-- The saved build settings of an app (website module, Apps). The build-form
-- values (runtime, install/build/start, health path, port variable, folder)
-- of the LAST HEALTHY deploy, kept here so "Redeploy" replays that exact
-- config without going through the build form or the AI again, and so the app
-- page can still show and edit the settings when ee has lost the workload's
-- own contract. NULL for apps built from their repo's ee.json (that file is
-- the config) and for apps never form-deployed. ee's company repo stays the
-- runtime source; this row is the owner-side deploy record.

ALTER TABLE "website_services" ADD COLUMN IF NOT EXISTS "contract" jsonb;
