-- Visual editor pins (phase-2d M6, V3): resolved values the owner set
-- directly on a draft visual set. pins[key] = value; light-mode keys are bare
-- cssVar names ('--primary'), dark-mode keys carry the 'dark:' prefix
-- ('dark:--background'). "Pins beat re-expansion": applySeedEdit
-- (modules/brand/style-format/reseed.ts) re-expands the seed block and then
-- re-applies these on top, so an owner's direct edits survive every later
-- seed change until explicitly cleared.

ALTER TABLE brand_visual_sets
  ADD COLUMN pins jsonb NOT NULL DEFAULT '{}'::jsonb;
