import type { WebApp } from './web-app'
import { createHash } from 'node:crypto'
import { mkdir, open, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { EeClient, PreviewBusyError, SubstrateError, SubstrateUnavailableError, type PreviewView } from '$lib/server/ee/client'
import { DriveError, type Actor, type DriveService } from './service'
import { writeTarGz } from './tar'

/**
 * Run a Drive web app folder on this box (plan/phase-drive-app-preview.md,
 * "Contract between ee and the kernel"). The kernel names the preview, takes
 * the folder's snapshot as a gzip'd tar under $EE_STATE_DIR/previews/ and
 * hands it to ee; ee installs, runs and serves it at its own origin. Without
 * ee, every act fails loud — never a fake success.
 */

export const NO_EE_MESSAGE = 'Running apps needs the eigenEnterprise server (ee).'

/** pv + the first 12 hex of sha256(folder id): stable per folder, so a restart keeps its host and certificate. */
export function previewIdFor(folderId: string): string {
  return `pv${createHash('sha256').update(folderId).digest('hex').slice(0, 12)}`
}

export const PREVIEW_ID = /^pv[0-9a-f]{12}$/

/** $EE_STATE_DIR/previews: the one place ee takes a snapshot from. Unset → refuse, never a default. */
export function resolvePreviewDir(env: Record<string, string | undefined>): string {
  const state = env.EE_STATE_DIR?.trim()
  if (!state) throw new Error('EE_STATE_DIR is not set: app previews hand their snapshot to ee under $EE_STATE_DIR/previews/, and there is no other place. Run under ee (it sets EE_STATE_DIR).')
  return join(state, 'previews')
}

/** ee refused because another app preview is active; `running` is that one. */
export class AppBusyError extends DriveError {
  constructor(
    readonly running: PreviewView,
    options?: { cause?: unknown },
  ) {
    super('busy', `Another app is running: ${running.folderName}`, undefined, options)
  }
}

export type AppPreviewDeps = {
  drive: DriveService
  ee: EeClient
  env: Record<string, string | undefined>
  now?: () => Date
}

export type AppStatus = {
  folder: { id: string; name: string }
  webApp: WebApp | null
  previewId: string
  /** false: not running under ee (reason says so); preview is then null. */
  managed: boolean
  reason: string | null
  preview: PreviewView | null
}

/** ee's failures as Drive's plain sentences: no ee, busy, or ee's own refusal. Anything else is a real failure. */
function eeFailure(err: unknown): never {
  if (err instanceof SubstrateUnavailableError) throw new DriveError('unavailable', NO_EE_MESSAGE, undefined, { cause: err })
  if (err instanceof PreviewBusyError) throw new AppBusyError(err.running, { cause: err })
  if (err instanceof SubstrateError) throw new DriveError('upstream', `The server could not do that: ${err.message}`, undefined, { cause: err })
  throw err
}

async function viaEe<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (err) {
    eeFailure(err)
  }
}

const unknown = (err: unknown) => err instanceof SubstrateError && err.status === 404

/**
 * A folder's web app facts and its preview, as ee has it. While a preview
 * exists this marks it seen (someone is looking at it), which resets ee's
 * idle clock. Without ee: managed false and the plain reason.
 */
export async function appStatus(deps: AppPreviewDeps, actor: Actor, folderId: string): Promise<AppStatus> {
  const { folder, webApp } = await deps.drive.webApp(actor, folderId)
  const base = { folder: { id: folder.id, name: folder.name }, webApp, previewId: previewIdFor(folder.id) }
  let preview: PreviewView | null
  try {
    preview = (await deps.ee.preview(base.previewId)).preview
    preview = (await deps.ee.previewSeen(base.previewId)).preview
  } catch (err) {
    if (err instanceof SubstrateUnavailableError) return { ...base, managed: false, reason: NO_EE_MESSAGE, preview: null }
    if (!unknown(err)) eeFailure(err)
    preview = null
  }
  return { ...base, managed: true, reason: null, preview }
}

/**
 * Snapshot the folder and (re)start its preview. The same folder restarts
 * from a new snapshot; another active preview → AppBusyError. The kernel's
 * copy of the tarball is removed when ee does not take it.
 */
export async function runApp(deps: AppPreviewDeps, actor: Actor, folderId: string, author: string): Promise<{ preview: PreviewView }> {
  const dir = resolvePreviewDir(deps.env)
  const { folder, webApp } = await deps.drive.webApp(actor, folderId)
  if (!webApp) throw new DriveError('invalid', `“${folder.name}” has no package.json with a dev or start script, so there is no app to run.`)
  // Ask ee first: without it a big snapshot would be written for nothing.
  await viaEe(() => deps.ee.previews())
  const snap = await deps.drive.snapshotFiles(actor, folderId)
  const id = previewIdFor(folder.id)
  await mkdir(dir, { recursive: true })
  const tarball = join(dir, `${id}-${(deps.now ?? (() => new Date()))().getTime()}.tar.gz`)
  const hash = createHash('sha256')
  let handedOver = false
  const fh = await open(tarball, 'wx', 0o600)
  try {
    try {
      await writeTarGz(snap.files, async (chunk) => {
        hash.update(chunk)
        await fh.write(chunk)
      })
    } finally {
      await fh.close()
    }
    const out = await viaEe(() => deps.ee.startPreview({ id, tarball, sha256: hash.digest('hex'), folderName: folder.name, author }))
    handedOver = true
    return out
  } finally {
    if (!handedOver) await rm(tarball, { force: true })
  }
}

/** Stop a preview (by its folder, or by id for "another app is running"). ee not knowing it → not_found. */
export async function stopApp(deps: AppPreviewDeps, target: { actor: Actor; folderId: string } | { previewId: string }, author: string): Promise<{ preview: PreviewView }> {
  let id: string
  if ('previewId' in target) {
    if (!PREVIEW_ID.test(target.previewId)) throw new DriveError('invalid', `“${target.previewId}” is not an app preview id.`)
    id = target.previewId
  } else id = previewIdFor((await deps.drive.folderInfo(target.actor, target.folderId)).id)
  try {
    return await deps.ee.stopPreview(id, { author })
  } catch (err) {
    if (unknown(err)) throw new DriveError('not_found', 'No app is running for this folder.', undefined, { cause: err })
    eeFailure(err)
  }
}
