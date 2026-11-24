import type { HubModulePublishV1, HubProblem } from './contract'
import { CORE_SCHEMA, load, YAMLException } from 'js-yaml'
import { CORE_API_VERSION } from '../../contracts/core-api-version'
import lock from '../../contracts/core-api.lock.json'
import { DEPRECATIONS } from '../../contracts/deprecations'
import { ModuleBundleError, readBundle, sha256Hex, type BundleEntry } from '../../contracts/module-bundle'
import {
  canonicalManifestJson,
  manifestCatalogGaps,
  MODULE_MANIFEST_FILE,
  safeParseModuleManifest,
  satisfiesCoreApi,
  type ManifestProblem,
  type ModuleManifestV1,
} from '../../contracts/module-manifest'
import { scanSecrets } from '../../scripts/oss-operator-secret-keys.mjs'

/**
 * The hub's six checks of a publish (plan/phase-upgrades-u2.md §6.2). Every
 * problem is collected — nothing stops at the first — so an author (or the
 * assistant) fixes everything in one go:
 *   1. bundle    the bundle parses (§6.1) and its sha256 is the one sent;
 *   2. manifest  the manifest sent is valid and equals the bundle's module.yaml;
 *   3. license   the licence is Apache-2.0 and LICENSE is in the bundle;
 *   4. core_api  the core-api range is satisfiable by the hub and the box;
 *   5. uses      every `uses` item is in the hub's lock (deprecated ones are listed);
 *   6. secrets   no credential, private key or operator key value in any file.
 * The hub never runs module code. Structure only: every check reads fields,
 * paths and patterns, never meaning.
 */

export const LICENSE = 'Apache-2.0'

/** What the hub offers a module: its lock, its core-api version and the deprecated items. */
export type HubCatalog = {
  coreApi: string
  tools: ReadonlySet<string>
  events: ReadonlySet<string>
  slots: ReadonlySet<string>
  /** Deprecated contract items in the deprecation notation (`tool:<name>`, `event:<type>`, `slot:<name>`). */
  deprecated: ReadonlySet<string>
}

/** The hub's own catalog: contracts/core-api.lock.json, CORE_API_VERSION and DEPRECATIONS. */
export function lockCatalog(): HubCatalog {
  return {
    coreApi: CORE_API_VERSION,
    tools: new Set(lock.tools.map((t) => t.name)),
    events: new Set(lock.events.map((e) => e.type)),
    slots: new Set((lock.uiSlots as { name: string }[]).map((s) => s.name)),
    deprecated: new Set(DEPRECATIONS.map((d) => d.item)),
  }
}

export type CheckedPublish = {
  problems: HubProblem[]
  /** Present when the bundle parsed. */
  entries: BundleEntry[] | null
  /** Present when the manifest sent is valid (licence aside). */
  manifest: ModuleManifestV1 | null
  deprecatedUses: string[]
}

type Raw = Record<string, unknown>

/** The value with a valid licence, so a wrong licence is reported once, by check 3, and the other checks still run. */
const withLicense = (raw: Raw): Raw => ({ ...raw, license: LICENSE })

function manifestProblems(problems: readonly ManifestProblem[], where: 'manifest' | 'module.yaml'): HubProblem[] {
  return problems
    .filter((p) => p.path !== 'license')
    .map((p) =>
      where === 'manifest'
        ? { check: 'manifest' as const, path: p.path ? `manifest.${p.path}` : 'manifest', message: p.message }
        : { check: 'manifest' as const, path: MODULE_MANIFEST_FILE, ...(p.line ? { line: p.line } : {}), message: p.path ? `${p.path}: ${p.message}` : p.message },
    )
}

function readYaml(text: string): { raw: Raw } | { problem: HubProblem } {
  try {
    const value = load(text, { schema: CORE_SCHEMA, filename: MODULE_MANIFEST_FILE })
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return { problem: { check: 'manifest', path: MODULE_MANIFEST_FILE, message: 'is not a YAML mapping' } }
    }
    return { raw: value as Raw }
  } catch (err) {
    if (err instanceof YAMLException) {
      const line = typeof err.mark?.line === 'number' ? err.mark.line + 1 : undefined
      return { problem: { check: 'manifest', path: MODULE_MANIFEST_FILE, ...(line ? { line } : {}), message: err.reason } }
    }
    throw err
  }
}

function fileText(e: Extract<BundleEntry, { type: 'file' }>): string {
  return new TextDecoder('utf-8').decode(e.content)
}

export function checkPublish(p: HubModulePublishV1, bytes: Uint8Array, catalog: HubCatalog): CheckedPublish {
  const problems: HubProblem[] = []

  // 1. bundle
  let entries: BundleEntry[] | null = null
  const sha = sha256Hex(bytes)
  if (sha !== p.bundle_sha256) {
    problems.push({ check: 'bundle', message: `the bundle's sha256 is ${sha}, not the bundle_sha256 sent (${p.bundle_sha256})` })
  }
  try {
    entries = readBundle(bytes).entries
  } catch (err) {
    if (!(err instanceof ModuleBundleError)) throw err
    for (const bp of err.problems) {
      // A missing LICENSE is check 3's to name.
      const check = bp.path === 'LICENSE' ? 'license' : 'bundle'
      problems.push({ check, ...(bp.path ? { path: bp.path } : {}), message: bp.message })
    }
  }
  const files = (entries ?? []).filter((e): e is Extract<BundleEntry, { type: 'file' }> => e.type === 'file')

  // 2. manifest (and the license field for 3)
  const sent = p.manifest
  const sentParse = safeParseModuleManifest(withLicense(sent))
  problems.push(...manifestProblems(sentParse.ok ? [] : sentParse.problems, 'manifest'))
  if (sent.license !== LICENSE) {
    problems.push({ check: 'license', path: 'manifest.license', message: `the licence must be ${LICENSE}, got ${JSON.stringify(sent.license ?? null)}` })
  }
  const manifest = sentParse.ok ? sentParse.manifest : null
  if (manifest && (manifest.id !== p.module_id || manifest.version !== p.version)) {
    problems.push({ check: 'manifest', path: 'manifest', message: `the manifest is ${manifest.id}@${manifest.version}, but module_id/version sent are ${p.module_id}@${p.version}` })
  }
  if (entries) {
    const yamlEntry = files.find((f) => f.path === MODULE_MANIFEST_FILE)
    const yaml = yamlEntry ? readYaml(fileText(yamlEntry)) : null
    if (yaml && 'problem' in yaml) problems.push(yaml.problem)
    if (yaml && 'raw' in yaml) {
      if (yaml.raw.license !== LICENSE) {
        problems.push({ check: 'license', path: MODULE_MANIFEST_FILE, message: `the licence must be ${LICENSE}, got ${JSON.stringify(yaml.raw.license ?? null)}` })
      }
      const yamlParse = safeParseModuleManifest(withLicense(yaml.raw))
      problems.push(...manifestProblems(yamlParse.ok ? [] : yamlParse.problems, 'module.yaml'))
      if (yamlParse.ok && manifest && canonicalManifestJson(withLicense(sent)) !== canonicalManifestJson(withLicense(yaml.raw))) {
        problems.push({ check: 'manifest', path: MODULE_MANIFEST_FILE, message: 'the bundle\'s module.yaml differs from the manifest sent' })
      }
    }
  }

  // 3. the LICENSE file: a missing one is named from the bundle's own problems above.

  // 4. core_api
  const deprecatedUses: string[] = []
  if (manifest) {
    const range = manifest.requires['core-api']
    if (!satisfiesCoreApi(range, catalog.coreApi)) {
      problems.push({ check: 'core_api', path: 'requires.core-api', message: `core-api ${range} is not satisfied by the hub's core-api ${catalog.coreApi}` })
    }
    if (!satisfiesCoreApi(range, p.core_api)) {
      problems.push({ check: 'core_api', path: 'requires.core-api', message: `core-api ${range} is not satisfied by the publishing box's core-api ${p.core_api}` })
    }

    // 5. uses
    for (const gap of manifestCatalogGaps(manifest, { tools: catalog.tools, events: catalog.events, slots: catalog.slots })) {
      problems.push({ check: 'uses', path: gap, message: `${gap} is not in the hub's core-api lock` })
    }
    const items = [
      ...manifest.uses.tools.map((t) => `tool:${t}`),
      ...manifest.uses.events.map((e) => `event:${e}`),
      ...manifest.uses.slots.map((s) => `slot:${s}`),
    ]
    for (const item of items) if (catalog.deprecated.has(item)) deprecatedUses.push(item)
  }

  // 6. secrets
  for (const f of files) {
    for (const finding of scanSecrets(fileText(f))) {
      problems.push({ check: 'secrets', path: f.path, line: finding.line, message: `${finding.message}: secrets never go into module code (declare it in permissions.secrets; an admin sets its value)` })
    }
  }

  return { problems, entries, manifest, deprecatedUses }
}
