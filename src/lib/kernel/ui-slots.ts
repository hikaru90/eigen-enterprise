/**
 * The UI slots the core offers modules (core-api 1.x, plan/phase-upgrades.md
 * R2): a slot is a named place in the shell a module's declarative UI may fill.
 * None exist yet (extensions X2 builds them); the list is explicit and empty so
 * `contracts/core-api.lock.json` locks "no slots" rather than omitting them.
 */
export type UiSlotDefinition = { name: string }

export const CORE_UI_SLOTS: readonly UiSlotDefinition[] = []
