import type { BundleStorage } from './bundles'
import type { HubModuleRow, HubModuleVersion, ModuleHubStore } from './store'
import type { HubFileContent, HubModuleDetail, HubModuleListItem, HubVersionDetail, HubVersionListItem } from './types'
import { z } from 'zod'
import { BUNDLE_LIMITS, bundleFileText, readBundle, type BundleEntry } from '../../contracts/module-bundle'
import { canonicalManifestJson, manifestSha256 } from '../../contracts/module-manifest'
import { signReceipt, type ModuleReceiptV1 } from '../../contracts/module-receipt'
import {
  bundleShaSchema,
  hubModulePublishV1,
  hubModuleRunV1,
  MAX_PUBLISH_BODY_BYTES,
  type HubProblem,
  type HubRefusalAnswer,
  type HubRunAnswer,
} from '../../src/lib/module-hub/contract'
import { checkPublish, LICENSE, type HubCatalog } from './checks'
import { ModuleHubError } from './errors'

/**
 * The module hub (plan/phase-upgrades-u2.md §6–§7), on the central box. Every
 * request is signed like a contribution and passes the contribute hub's own
 * authentication first (injected as `authenticate`; the composition in
 * src/lib/server/module-hub wires it, so no module imports another) — unknown install / bad or stale signature → 401,
 * revoked → 403, replay → 401, over the hourly limit → 429 — before any byte
 * of the body is read. Then:
 *
 *   publish  413 too large · 400 a body off the strict schema · 422 every
 *            problem of the six checks · 409 the same commit with another
 *            bundle (or these bytes as another module) · 200 the same receipt
 *            again for the same install, id and bundle · 201 a new receipt.
 *   bundle   200 the bytes of a published bundle (for a restore), 404 unknown.
 *   run      200 which installs run the module.
 */

/** A request as the route hands it over: the raw body, read once. */
export type ModuleHubRequest = { method: string; path: string; headers: Headers; body: string }
export type ModuleHubReply = { status: number; body: Record<string, unknown> }

export type ModuleHubDeps = {
  /**
   * The contribute hub's authentication of a signed request (installs,
   * signature, revoked, replay guard, rate limit); throws its own errors.
   */
  authenticate: (req: ModuleHubRequest) => Promise<{ installId: string }>
  /** Epoch ms (injected so specs move the clock). */
  now: () => number
  store: ModuleHubStore
  bundles: BundleStorage
  /** The hub's Ed25519 receipt key, base64 DER PKCS#8 (`MODULE_HUB_SIGNING_KEY`); throws when unset. */
  signingKey: () => string
  /** The hub's own origin (scheme://host[:port]), named in every receipt. */
  origin: () => string
  catalog: HubCatalog
  /** Queues the summary of a newly published version (a job-queue job through the gateway). */
  enqueueSummary: (bundleSha256: string) => Promise<void>
}

export type HubBinaryReply = { status: 200; bytes: Uint8Array; contentType: string }

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body)
  } catch {
    throw new ModuleHubError('invalid', 'expected a JSON body')
  }
}

function strict<T>(schema: z.ZodType<T>, body: string): T {
  const parsed = schema.safeParse(parseJson(body))
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw new ModuleHubError('invalid', `invalid body: ${issue?.path.join('.') || '(root)'}: ${issue?.message ?? 'does not match'}`)
  }
  return parsed.data
}

function refusal(status: 409 | 413 | 422, problems: HubProblem[]): ModuleHubReply {
  const code: HubRefusalAnswer['code'] = status === 409 ? 'conflict' : status === 413 ? 'too_large' : 'refused'
  const error =
    status === 422
      ? `the module hub refused this bundle: ${problems.length} problem${problems.length === 1 ? '' : 's'}`
      : (problems[0]?.message ?? 'refused')
  const body: HubRefusalAnswer = { error, code, problems }
  return { status, body }
}

const short = (sha: string) => sha.slice(0, 12)

/** 200 with the stored receipt, or 409 when these bytes were published as another module or commit. */
async function existingAnswer(deps: ModuleHubDeps, existing: HubModuleVersion, installId: string, moduleId: string, commit: string): Promise<ModuleHubReply> {
  if (existing.installId !== installId || existing.moduleId !== moduleId || existing.commit !== commit) {
    return refusal(409, [{ check: 'bundle', message: `bundle ${short(existing.bundleSha256)} is already published as another module or commit` }])
  }
  if (!existing.summary) await deps.enqueueSummary(existing.bundleSha256)
  return { status: 200, body: { receipt: existing.receipt } }
}

/** POST /api/hub/modules/publish. */
export async function publishModule(deps: ModuleHubDeps, req: ModuleHubRequest): Promise<ModuleHubReply> {
  const install = await deps.authenticate(req)
  if (Buffer.byteLength(req.body) > MAX_PUBLISH_BODY_BYTES) {
    return refusal(413, [{ check: 'bundle', message: `the request is over ${MAX_PUBLISH_BODY_BYTES} bytes; a bundle is at most ${BUNDLE_LIMITS.packedBytes} bytes packed` }])
  }
  const p = strict(hubModulePublishV1, req.body)
  const bytes = new Uint8Array(Buffer.from(p.bundle_b64, 'base64'))
  if (bytes.byteLength > BUNDLE_LIMITS.packedBytes) {
    return refusal(413, [{ check: 'bundle', message: `${bytes.byteLength} bytes packed, at most ${BUNDLE_LIMITS.packedBytes}` }])
  }

  const checked = checkPublish(p, bytes, deps.catalog)
  if (checked.problems.length > 0) return refusal(422, checked.problems)
  const manifest = checked.manifest
  const entries = checked.entries
  if (!manifest || !entries) throw new Error('module hub: checks passed without a manifest and a bundle')

  const byCommit = await deps.store.versionByCommit(install.installId, p.module_id, p.commit)
  if (byCommit && byCommit.bundleSha256 !== p.bundle_sha256) {
    return refusal(409, [
      { check: 'commit', message: `commit ${p.commit.slice(0, 12)} of ${p.module_id} is already published as bundle ${short(byCommit.bundleSha256)}; a commit pins one bundle` },
    ])
  }
  const existing = await deps.store.getVersion(p.bundle_sha256)
  if (existing) return existingAnswer(deps, existing, install.installId, p.module_id, p.commit)

  const at = new Date(deps.now())
  const receipt: ModuleReceiptV1 = signReceipt(
    {
      hub: deps.origin(),
      installId: install.installId,
      moduleId: manifest.id,
      version: manifest.version,
      commit: p.commit,
      bundleSha256: p.bundle_sha256,
      manifestSha256: manifestSha256(p.manifest),
      coreApi: p.core_api,
      license: LICENSE,
      deprecatedUses: checked.deprecatedUses,
      issuedAt: at.toISOString(),
    },
    deps.signingKey(),
  )
  // Content-addressed: stored before the row, so a row never names missing bytes.
  await deps.bundles.put(p.bundle_sha256, bytes)
  const inserted = await deps.store.insertVersion({
    bundleSha256: p.bundle_sha256,
    installId: install.installId,
    moduleId: manifest.id,
    version: manifest.version,
    commit: p.commit,
    manifest: JSON.parse(canonicalManifestJson(p.manifest)),
    coreApi: p.core_api,
    uses: manifest.uses,
    provides: manifest.provides,
    permissions: manifest.permissions,
    files: entries.flatMap((e) => (e.type === 'file' ? [{ path: e.path, size: e.size, mode: e.mode }] : [])),
    bytes: bytes.byteLength,
    deprecatedUses: checked.deprecatedUses,
    receipt,
    publishedAt: at,
    summary: null,
    summaryAt: null,
  })
  if (!inserted) {
    // Published concurrently: answer as for a repeat.
    const raced = (await deps.store.getVersion(p.bundle_sha256)) ?? (await deps.store.versionByCommit(install.installId, p.module_id, p.commit))
    if (!raced) throw new Error(`module hub: version ${p.bundle_sha256} vanished during publish`)
    if (raced.bundleSha256 !== p.bundle_sha256) {
      return refusal(409, [{ check: 'commit', message: `commit ${p.commit.slice(0, 12)} of ${p.module_id} is already published as bundle ${short(raced.bundleSha256)}; a commit pins one bundle` }])
    }
    return existingAnswer(deps, raced, install.installId, p.module_id, p.commit)
  }
  await deps.enqueueSummary(p.bundle_sha256)
  return { status: 201, body: { receipt } }
}

function shaParam(sha: string): string {
  if (!bundleShaSchema.safeParse(sha).success) throw new ModuleHubError('invalid', 'the bundle sha256 in the path is not 64 lowercase hex')
  return sha
}

/** GET /api/hub/modules/bundles/:sha256 — any registered install may fetch a published bundle (a restore re-fetches by sha). */
export async function fetchModuleBundle(deps: ModuleHubDeps, req: ModuleHubRequest, sha256: string): Promise<HubBinaryReply> {
  await deps.authenticate(req)
  if (req.body !== '') throw new ModuleHubError('invalid', 'a GET carries no body')
  const sha = shaParam(sha256)
  if (!(await deps.store.getVersion(sha))) throw new ModuleHubError('not_found', `no published bundle ${short(sha)} on the module hub`)
  const bytes = await deps.bundles.get(sha)
  if (!bytes) throw new Error(`module hub: bundle ${sha} is published but its file is missing from the bundle store`)
  return { status: 200, bytes, contentType: 'application/gzip' }
}

/** PUT /api/hub/modules/:module_id/run — the reporting install's run state of one release. */
export async function reportModuleRun(deps: ModuleHubDeps, req: ModuleHubRequest, moduleId: string): Promise<ModuleHubReply> {
  const install = await deps.authenticate(req)
  const p = strict(hubModuleRunV1, req.body)
  const version = await deps.store.getVersion(p.bundle_sha256)
  if (!version) throw new ModuleHubError('not_found', `no published bundle ${short(p.bundle_sha256)} on the module hub`)
  if (version.moduleId !== moduleId) throw new ModuleHubError('invalid', `bundle ${short(p.bundle_sha256)} is module ${version.moduleId}, not ${moduleId}`)
  await deps.store.reportRun({ installId: install.installId, moduleId, bundleSha256: p.bundle_sha256, state: p.state, reportedAt: new Date(deps.now()) })
  const runs = await deps.store.runs(version.installId, version.moduleId)
  const body: HubRunAnswer = {
    module_id: moduleId,
    runs: runs.map((r) => ({ install_id: r.installId, bundle_sha256: r.bundleSha256, version: r.version, state: r.state, reported_at: r.reportedAt.toISOString() })),
  }
  return { status: 200, body }
}

// ─── The owner's reads (module_hub.* tools) ──────────────────────────────────

export const HUB_LIST_PAGE = 50
/** The most of one file a read returns. */
export const HUB_FILE_MAX_BYTES = 256 * 1024

function listItem(m: HubModuleRow): HubModuleListItem {
  return {
    installId: m.installId,
    moduleId: m.moduleId,
    name: m.name,
    description: m.description,
    latestVersion: m.latestVersion,
    latestBundleSha256: m.latestBundleSha256,
    versions: m.versions,
    firstPublishedAt: m.firstPublishedAt.toISOString(),
    lastPublishedAt: m.lastPublishedAt.toISOString(),
  }
}

function versionItem(v: HubModuleVersion): HubVersionListItem {
  return { bundleSha256: v.bundleSha256, version: v.version, commit: v.commit, publishedAt: v.publishedAt.toISOString(), summary: v.summary }
}

const cursorSchema = z.string().regex(/^\d{1,9}$/)

/** Modules of installs that are not revoked, most recently published first; `cursor` is the next page's offset. */
export async function listHubModules(deps: Pick<ModuleHubDeps, 'store'>, opts: { query?: string; cursor?: string }): Promise<{ modules: HubModuleListItem[]; cursor: string | null }> {
  if (opts.cursor !== undefined && !cursorSchema.safeParse(opts.cursor).success) throw new ModuleHubError('invalid', 'cursor is not one this listing gave')
  const offset = opts.cursor ? Number(opts.cursor) : 0
  const rows = await deps.store.listModules({ query: opts.query, offset, limit: HUB_LIST_PAGE + 1 })
  const page = rows.slice(0, HUB_LIST_PAGE).map(listItem)
  return { modules: page, cursor: rows.length > HUB_LIST_PAGE ? String(offset + HUB_LIST_PAGE) : null }
}

export async function getHubModule(deps: Pick<ModuleHubDeps, 'store'>, installId: string, moduleId: string): Promise<HubModuleDetail> {
  const m = await deps.store.getModule(installId, moduleId)
  if (!m) throw new ModuleHubError('not_found', `no module ${moduleId} of install ${installId.slice(0, 8)} on the module hub`)
  const [versions, runs] = await Promise.all([deps.store.versions(installId, moduleId), deps.store.runs(installId, moduleId)])
  return {
    module: listItem(m),
    versions: versions.map(versionItem),
    runs: runs.map((r) => ({ installId: r.installId, bundleSha256: r.bundleSha256, version: r.version, state: r.state, reportedAt: r.reportedAt.toISOString() })),
  }
}

async function version(deps: Pick<ModuleHubDeps, 'store'>, sha256: string): Promise<HubModuleVersion> {
  const v = await deps.store.getVersion(shaParam(sha256))
  if (!v) throw new ModuleHubError('not_found', `no published bundle ${short(sha256)} on the module hub`)
  return v
}

export async function getHubVersion(deps: Pick<ModuleHubDeps, 'store'>, sha256: string): Promise<HubVersionDetail> {
  const v = await version(deps, sha256)
  return {
    installId: v.installId,
    moduleId: v.moduleId,
    bundleSha256: v.bundleSha256,
    version: v.version,
    commit: v.commit,
    coreApi: v.coreApi,
    manifest: v.manifest as unknown as Record<string, unknown>,
    uses: v.uses as unknown as Record<string, unknown>,
    provides: v.provides as unknown as Record<string, unknown>,
    permissions: v.permissions as unknown as Record<string, unknown>,
    deprecatedUses: v.deprecatedUses,
    bytes: v.bytes,
    files: v.files.length,
    receipt: v.receipt,
    publishedAt: v.publishedAt.toISOString(),
    summary: v.summary,
    summaryAt: v.summaryAt?.toISOString() ?? null,
  }
}

export async function hubVersionTree(deps: Pick<ModuleHubDeps, 'store'>, sha256: string) {
  const v = await version(deps, sha256)
  return { bundleSha256: v.bundleSha256, moduleId: v.moduleId, version: v.version, files: v.files }
}

/** The bundle's entries (read from the bundle store, checked again). */
export async function bundleEntries(deps: Pick<ModuleHubDeps, 'store' | 'bundles'>, sha256: string): Promise<{ version: HubModuleVersion; entries: BundleEntry[] }> {
  const v = await version(deps, sha256)
  const bytes = await deps.bundles.get(v.bundleSha256)
  if (!bytes) throw new Error(`module hub: bundle ${v.bundleSha256} is published but its file is missing from the bundle store`)
  return { version: v, entries: readBundle(bytes).entries }
}

export async function hubVersionFile(deps: Pick<ModuleHubDeps, 'store' | 'bundles'>, sha256: string, path: string): Promise<HubFileContent> {
  const { entries } = await bundleEntries(deps, sha256)
  const e = entries.find((x) => x.type === 'file' && x.path === path)
  if (!e || e.type !== 'file') throw new ModuleHubError('not_found', `no file ${path} in bundle ${short(sha256)}`)
  let text: string | null
  try {
    text = bundleFileText(entries, path)
  } catch {
    text = null
  }
  if (text === null) return { path, size: e.size, binary: true }
  const truncated = e.size > HUB_FILE_MAX_BYTES
  return { path, size: e.size, binary: false, content: truncated ? new TextDecoder().decode(e.content.subarray(0, HUB_FILE_MAX_BYTES)) : text, truncated }
}
