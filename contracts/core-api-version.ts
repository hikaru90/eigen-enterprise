/**
 * The core contract's own semver (plan/phase-upgrades.md R4), recorded in
 * `contracts/core-api.lock.json`. Additive releases may keep it; any removal
 * (a breaking change whose deprecation window ended) needs a major bump here —
 * `npm run contract:check` refuses one without it. Modules declare
 * `requires.core-api` against this version.
 */
export const CORE_API_VERSION = '1.0.0'
