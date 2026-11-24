/**
 * Module hub trust (plan/phase-upgrades-u2.md §5 "Hub trust", D11): ee runs a
 * module's bytes only under a receipt signed by a key it trusts. The company
 * repo's `settings.moduleHub {origin, publicKeys[]}` names the hub; it is set
 * only by root's `ee bootstrap --module-hub <origin> [--module-hub-key <spki>]`,
 * never by a control verb, so the os can never widen what ee trusts.
 *
 * The default is the official hub with the keys embedded here, current plus an
 * offline backup (as release-key.ts does for releases). Keys given with
 * --module-hub-key REPLACE the embedded ones; a hub other than the official one
 * needs them. Keys are Ed25519, base64 DER SPKI (contracts/module-receipt.ts).
 *
 * The keys between the markers are written by scripts/hub-key.sh (the backup by
 * `scripts/hub-key.sh --backup`) — do not edit by hand.
 */

import { createPublicKey } from 'node:crypto'
import { z } from 'zod'
import { TEST_ONLY_MODULE_HUB_PUBLIC_KEY_SPKI } from '../../contracts/fixtures/module-hub-test-key.ts'
import { keyId } from '../../contracts/module-receipt.ts'
import { OFFICIAL_CONTRIBUTE_HUB } from './contribute-hub.ts'

/** The official module hub: the project's central box, which also runs the central Contribute board. */
export const OFFICIAL_MODULE_HUB = OFFICIAL_CONTRIBUTE_HUB

/** The explicit "no key yet" values; scripts/hub-key.sh replaces them. */
export const HUB_KEY_PLACEHOLDER = 'PLACEHOLDER: no module hub key yet (run scripts/hub-key.sh)'
export const HUB_BACKUP_KEY_PLACEHOLDER = 'PLACEHOLDER: no backup module hub key yet (run scripts/hub-key.sh --backup)'

// BEGIN MODULE HUB PUBLIC KEY (written by scripts/hub-key.sh)
export const MODULE_HUB_PUBLIC_KEY_SPKI: string = HUB_KEY_PLACEHOLDER
// END MODULE HUB PUBLIC KEY

// BEGIN MODULE HUB BACKUP PUBLIC KEY (written by scripts/hub-key.sh --backup)
export const MODULE_HUB_BACKUP_PUBLIC_KEY_SPKI: string = HUB_BACKUP_KEY_PLACEHOLDER
// END MODULE HUB BACKUP PUBLIC KEY

export const NO_HUB_KEY_MESSAGE =
  'this build embeds no module hub key (run scripts/hub-key.sh), and none was given with `ee bootstrap --module-hub-key`, so no module can run'

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/

/** Checks one hub public key: base64 DER SPKI, Ed25519, never the repo's public test key. Returns it unchanged. */
export function checkHubKey(spki: string, which = 'module hub key'): string {
  if (!BASE64.test(spki)) throw new Error(`the ${which} must be base64 DER SPKI (got "${spki.slice(0, 60)}")`)
  let type: string | undefined
  try {
    type = createPublicKey({ key: Buffer.from(spki, 'base64'), format: 'der', type: 'spki' }).asymmetricKeyType
  } catch (err) {
    throw new Error(`the ${which} is not a public key: ${(err as Error).message}`, { cause: err })
  }
  if (type !== 'ed25519') throw new Error(`the ${which} is ${type}, not ed25519`)
  if (keyId(spki) === keyId(TEST_ONLY_MODULE_HUB_PUBLIC_KEY_SPKI)) {
    throw new Error(`the ${which} is the repo's public TEST key (contracts/fixtures/module-hub-test-key.ts); no box may trust it`)
  }
  return spki
}

/** The embedded key set: the current key (required) plus the backup unless it is still the placeholder. */
export function embeddedHubKeys(current: string = MODULE_HUB_PUBLIC_KEY_SPKI, backup: string = MODULE_HUB_BACKUP_PUBLIC_KEY_SPKI): string[] {
  if (current === HUB_KEY_PLACEHOLDER) throw new Error(NO_HUB_KEY_MESSAGE)
  const keys = [checkHubKey(current, 'embedded module hub key')]
  if (backup === HUB_BACKUP_KEY_PLACEHOLDER) return keys
  checkHubKey(backup, 'embedded backup module hub key')
  if (keyId(backup) === keyId(current)) throw new Error('the backup module hub key is the current key (it must be a second, offline key)')
  return [...keys, backup]
}

const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\]|[a-z0-9.-]+\.localhost|[a-z0-9.-]+\.test)$/

/** An origin a hub may have: https, or http only for a local test host (loopback, *.localhost, *.test). */
function originProblem(origin: string): string | null {
  let url: URL
  try {
    url = new URL(origin)
  } catch {
    return 'must be an origin like https://hub.example.com'
  }
  if (url.origin !== origin) return `must be an origin only (e.g. ${OFFICIAL_MODULE_HUB})`
  if (url.protocol === 'https:') return null
  if (url.protocol === 'http:' && LOCAL_HOST.test(url.hostname)) return null
  return 'must use https (http only for a local test host)'
}

export const moduleHubSchema = z
  .object({
    origin: z.string().max(400).superRefine((o, ctx) => {
      const problem = originProblem(o)
      if (problem) ctx.addIssue({ code: 'custom', message: `moduleHub.origin ${problem}` })
    }),
    /** Keys given with --module-hub-key; empty = the keys embedded in this ee build (official hub only). */
    publicKeys: z.array(z.string().regex(BASE64)).max(2),
  })
  .strict()
  .superRefine((h, ctx) => {
    if (h.publicKeys.length === 0 && h.origin !== OFFICIAL_MODULE_HUB) {
      ctx.addIssue({ code: 'custom', message: `the module hub ${h.origin} has no key: pass --module-hub-key <spki> with --module-hub` })
    }
  })

export type ModuleHub = z.infer<typeof moduleHubSchema>

export const DEFAULT_MODULE_HUB: ModuleHub = { origin: OFFICIAL_MODULE_HUB, publicKeys: [] }

/** `--module-hub <origin>`, checked in plain words. */
export function parseModuleHubFlag(flag: string): string {
  const problem = originProblem(flag)
  if (problem) throw new Error(`--module-hub "${flag}" ${problem}`)
  return flag
}

/** `--module-hub-key <spki>` (repeatable, at most two: current and backup). */
export function parseModuleHubKeyFlags(flags: string[]): string[] {
  if (flags.length > 2) throw new Error('--module-hub-key takes at most two keys (the current one and an offline backup)')
  const keys = flags.map((k) => checkHubKey(k.trim(), `--module-hub-key "${k.slice(0, 20)}…"`))
  if (keys.length === 2 && keyId(keys[0]!) === keyId(keys[1]!)) throw new Error('--module-hub-key was given the same key twice')
  return keys
}

/**
 * What a bootstrap (re-)run saves: explicit flags win, a plain re-run keeps
 * what the company has. Moving to another hub drops the old hub's keys (they
 * were that hub's), so a non-official hub must come with its keys.
 */
export function resolveModuleHub(flags: { origin?: string; keys?: string[] }, stored: ModuleHub): ModuleHub {
  const origin = flags.origin ?? stored.origin
  const keys = flags.keys ?? (origin === stored.origin ? stored.publicKeys : [])
  return moduleHubSchema.parse({ origin, publicKeys: keys })
}

/** The keys a receipt may be signed with on this box (throws, in plain words, when there are none). */
export function trustedHubKeys(hub: ModuleHub, embedded: () => string[] = () => embeddedHubKeys()): string[] {
  if (hub.publicKeys.length > 0) return hub.publicKeys.map((k) => checkHubKey(k))
  if (hub.origin !== OFFICIAL_MODULE_HUB) {
    throw new Error(`the module hub ${hub.origin} has no key: run ee bootstrap --module-hub ${hub.origin} --module-hub-key <spki>`)
  }
  return embedded()
}

/** The os workload's env with MODULE_HUB_URL: where the kernel publishes module bundles. */
export function moduleHubEnv(env: Record<string, string>, hub: ModuleHub): Record<string, string> {
  return { ...env, MODULE_HUB_URL: hub.origin }
}
