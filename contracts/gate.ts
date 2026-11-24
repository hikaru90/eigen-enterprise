import type { Deprecation } from './deprecations'
import { evaluateContract, type ContractChange } from './classify'
import { parseLock, serializeLock, type CoreApiLock } from './lock'
import { generateSdk } from './sdk-gen'

/**
 * `contract:lock` and `contract:check` over files (paths and IO injected, so
 * the decisions are unit-testable): the lock writer refuses to record a diff
 * the gate would refuse, and the check fails on any refused diff, a stale
 * lock or a stale SDK.
 */

export const LOCK_PATH = 'contracts/core-api.lock.json'
export const SDK_PATH = 'contracts/sdk/core-api.ts'

export type GateFiles = {
  read(path: string): string | null
  write(path: string, text: string): void
}

export type GateInput = {
  current: CoreApiLock
  deprecations: readonly Deprecation[]
  release: string
  today: string
  files: GateFiles
}

export type GateResult = {
  ok: boolean
  /** One line per problem, each saying what to do. */
  problems: string[]
  changes: ContractChange[]
}

/** A contract as the lock file records it (canonical: sorted keys, `required` as a sorted set). */
function asWritten(lock: CoreApiLock): CoreApiLock {
  return parseLock(serializeLock(lock), LOCK_PATH)
}

/** The SDK is generated from the lock as written, never from the in-memory snapshot. */
function sdkOf(lock: CoreApiLock): string {
  return generateSdk(asWritten(lock))
}

function classify(input: GateInput, locked: CoreApiLock) {
  return evaluateContract({
    locked,
    current: asWritten(input.current),
    deprecations: input.deprecations,
    release: input.release,
    today: input.today,
  })
}

/** Regenerate the lock and SDK — only for a diff the gate accepts (the first lock bootstraps). */
export function writeLock(input: GateInput): GateResult {
  const existing = input.files.read(LOCK_PATH)
  if (existing !== null) {
    const { changes, violations } = classify(input, parseLock(existing, LOCK_PATH))
    if (violations.length > 0) return { ok: false, problems: violations, changes }
    input.files.write(LOCK_PATH, serializeLock(input.current))
    input.files.write(SDK_PATH, sdkOf(input.current))
    return { ok: true, problems: [], changes }
  }
  input.files.write(LOCK_PATH, serializeLock(input.current))
  input.files.write(SDK_PATH, sdkOf(input.current))
  return { ok: true, problems: [], changes: [] }
}

/** The gate: no refused diff, the lock and the SDK exactly what the working tree generates. */
export function checkLock(input: GateInput): GateResult {
  const existing = input.files.read(LOCK_PATH)
  if (existing === null) {
    return {
      ok: false,
      problems: [`${LOCK_PATH} is missing: run npm run contract:lock`],
      changes: [],
    }
  }
  const { changes, violations } = classify(input, parseLock(existing, LOCK_PATH))
  const problems = [...violations]
  if (existing !== serializeLock(input.current)) {
    problems.push(
      `${LOCK_PATH} is stale (${changes.length} change(s) not recorded): run npm run contract:lock and commit the lock and the SDK`,
    )
  }
  if (input.files.read(SDK_PATH) !== generateSdk(parseLock(existing, LOCK_PATH))) {
    problems.push(
      `${SDK_PATH} is not what the lock generates: run npm run contract:lock (never edit the SDK by hand)`,
    )
  }
  return { ok: problems.length === 0, problems, changes }
}
