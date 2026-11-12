import type { DriveAccessPort } from './access-port'
import type { BlobStore } from './storage'
import type { DriveFile, DriveFolder, DriveSourceRow, DriveStore } from './store'
import { randomUUID } from 'node:crypto'
import { sha256Hex } from './storage'

/**
 * Drive's system writer for read-only source folders (plan/github-drive.md
 * §5). A source plugin (e.g. GitHub repos) writes its copies through this,
 * by its own stable keys; the items it makes carry `source` and are
 * read-only in the service for everyone.
 *
 * It bypasses Drive's access checks (no person or agent acts) and is never a
 * kernel tool. The types below are structurally the consumer's contract
 * (`DriveSourcePort`, modules/repos/drive-port.ts); Drive never imports it —
 * the composition root (modules/index.ts) hands this writer over.
 */

export type DriveSourceId = string

export type DriveSourceRoot = {
  source: DriveSourceId
  /** Drive folder id of the root. */
  folderId: string
  /** Name shown in the Drive rail and the path. */
  name: string
}

export type DriveSourceItem = {
  key: string
  kind: 'folder' | 'file'
  itemId: string
  /** The parent's key; null for items directly under the root. */
  parentKey: string | null
  /** sha256 of the file's bytes; null for folders. */
  contentSha: string | null
}

export type DriveSourceWriter = {
  /** Creates the source's root folder on first use (with the company-wide view grant) or renames it; returns it. Idempotent. */
  ensureRoot(source: DriveSourceId, name: string): Promise<DriveSourceRoot>
  /** Creates or renames/moves a folder addressed by `key`; the parent must exist (null = root). Returns its id. */
  upsertFolder(source: DriveSourceId, key: string, parentKey: string | null, name: string): Promise<string>
  /** Creates or updates a `text/markdown` file (no revisions); a blob and `updatedAt` only when the sha256 changed. */
  upsertText(source: DriveSourceId, key: string, parentKey: string | null, name: string, content: string): Promise<{ fileId: string; changed: boolean }>
  /** Deletes for good every item whose key is `keyPrefix` or starts with `keyPrefix + '/'`; returns how many. */
  remove(source: DriveSourceId, keyPrefix: string): Promise<number>
  /** Every item of the source (the root excluded). */
  list(source: DriveSourceId): Promise<DriveSourceItem[]>
}

export type SourceWriterDeps = {
  store: DriveStore
  blobs: BlobStore
  access: Pick<DriveAccessPort, 'systemGrants' | 'listGrants'>
  now?: () => Date
}

/** Drive's naming rule, failing loud: a source names things itself, so a bad name is its bug. */
function checkName(name: string): string {
  if (!name || name !== name.trim()) throw new Error(`drive source item name must be non-empty, without leading or trailing spaces, got ${JSON.stringify(name)}`)
  if (name.length > 255) throw new Error(`drive source item name is longer than 255 characters: ${JSON.stringify(name.slice(0, 40))}…`)
  if (/[/\\]/.test(name) || name === '.' || name === '..') throw new Error(`drive source item name can't contain / or \\ (or be . or ..): ${JSON.stringify(name)}`)
  return name
}

function checkId(what: string, value: string): void {
  if (!value) throw new Error(`drive source ${what} must be non-empty`)
}

export function createDriveSourceWriter(deps: SourceWriterDeps): DriveSourceWriter {
  const { store, blobs, access } = deps
  const now = deps.now ?? (() => new Date())

  async function rootOf(source: string): Promise<DriveFolder | null> {
    const roots = (await store.sourceRoots()).filter((r) => r.source === source)
    if (roots.length > 1) throw new Error(`drive source ${source} has ${roots.length} root folders`)
    return roots[0] ?? null
  }

  async function requireRoot(source: string): Promise<DriveFolder> {
    const root = await rootOf(source)
    if (!root) throw new Error(`drive source ${source} has no root folder yet: call ensureRoot first`)
    return root
  }

  /** The Drive folder a parent key names (null = the root); it must be a folder of this source. */
  async function parentFolderId(source: string, parentKey: string | null): Promise<string> {
    if (parentKey === null) return (await requireRoot(source)).id
    const parent = await store.getSourceItem(source, parentKey)
    if (!parent) throw new Error(`drive source ${source}: parent ${parentKey} does not exist`)
    if (parent.kind !== 'folder') throw new Error(`drive source ${source}: parent ${parentKey} is a file, not a folder`)
    return parent.itemId
  }

  /** The folders from `folderId` up (itself included). */
  async function chainIds(folderId: string): Promise<string[]> {
    const out: string[] = []
    let id: string | null = folderId
    while (id) {
      if (out.includes(id)) throw new Error(`drive folder cycle at ${id}`)
      out.push(id)
      const f: DriveFolder | null = await store.getFolder(id)
      if (!f) throw new Error(`drive folder ${id} is missing`)
      id = f.parentId
    }
    return out
  }

  const toItem = (r: DriveSourceRow): DriveSourceItem => ({ key: r.externalKey, kind: r.kind, itemId: r.itemId, parentKey: r.parentKey, contentSha: r.contentSha })

  return {
    async ensureRoot(source, name) {
      checkId('id', source)
      checkName(name)
      const existing = await rootOf(source)
      if (existing) {
        if (existing.name !== name) await store.updateFolder(existing.id, { name, updatedAt: now() })
        return { source, folderId: existing.id, name }
      }
      const at = now()
      const root: DriveFolder = {
        id: randomUUID(),
        parentId: null,
        name,
        ownerId: source,
        createdAt: at,
        updatedAt: at,
        trashedAt: null,
        archivedAt: null,
        archivedBy: null,
        source,
      }
      await store.insertFolder(root)
      // Owner decision: the whole company sees a source; admins can narrow it with normal sharing.
      await access.systemGrants(source, 'folder', root.id, [{ resourceType: 'folder', resourceId: root.id, subject: { kind: 'company' }, level: 'view' }])
      return { source, folderId: root.id, name }
    },

    async upsertFolder(source, key, parentKey, name) {
      checkId('key', key)
      checkName(name)
      const parentId = await parentFolderId(source, parentKey)
      const existing = await store.getSourceItem(source, key)
      if (existing) {
        if (existing.kind !== 'folder') throw new Error(`drive source ${source}: ${key} is a file, not a folder`)
        const folder = await store.getFolder(existing.itemId)
        if (!folder) throw new Error(`drive source ${source}: folder ${existing.itemId} for ${key} is missing`)
        if (folder.parentId !== parentId && (await chainIds(parentId)).includes(folder.id)) {
          throw new Error(`drive source ${source}: ${key} can't move into itself (${parentKey})`)
        }
        if (folder.name !== name || folder.parentId !== parentId) await store.updateFolder(folder.id, { name, parentId, updatedAt: now() })
        if (existing.parentKey !== parentKey) await store.putSourceItem({ ...existing, parentKey })
        return folder.id
      }
      const at = now()
      const folder: DriveFolder = {
        id: randomUUID(),
        parentId,
        name,
        ownerId: source,
        createdAt: at,
        updatedAt: at,
        trashedAt: null,
        archivedAt: null,
        archivedBy: null,
        source,
      }
      await store.insertFolder(folder)
      await store.putSourceItem({ source, externalKey: key, itemId: folder.id, kind: 'folder', parentKey, contentSha: null })
      return folder.id
    },

    async upsertText(source, key, parentKey, name, content) {
      checkId('key', key)
      checkName(name)
      const folderId = await parentFolderId(source, parentKey)
      const bytes = new TextEncoder().encode(content)
      const sha = sha256Hex(bytes)
      const existing = await store.getSourceItem(source, key)
      if (existing) {
        if (existing.kind !== 'file') throw new Error(`drive source ${source}: ${key} is a folder, not a file`)
        const file = await store.getFile(existing.itemId)
        if (!file) throw new Error(`drive source ${source}: file ${existing.itemId} for ${key} is missing`)
        const changed = file.sha256 !== sha
        if (changed) {
          const blob = await blobs.put(bytes)
          await store.updateFile(file.id, { sha256: blob.sha256, size: blob.size, updatedAt: now(), name, folderId })
          if (!(await store.blobInUse(file.sha256))) await blobs.remove(file.sha256)
        } else if (file.name !== name || file.folderId !== folderId) await store.updateFile(file.id, { name, folderId })
        if (changed || existing.parentKey !== parentKey || existing.contentSha !== sha) await store.putSourceItem({ ...existing, parentKey, contentSha: sha })
        return { fileId: file.id, changed }
      }
      const blob = await blobs.put(bytes)
      const at = now()
      const file: DriveFile = {
        id: randomUUID(),
        folderId,
        name,
        ownerId: source,
        mime: 'text/markdown',
        size: blob.size,
        sha256: blob.sha256,
        createdAt: at,
        updatedAt: at,
        trashedAt: null,
        archivedAt: null,
        archivedBy: null,
        source,
      }
      await store.insertFile(file)
      await store.putSourceItem({ source, externalKey: key, itemId: file.id, kind: 'file', parentKey, contentSha: blob.sha256 })
      return { fileId: file.id, changed: true }
    },

    async remove(source, keyPrefix) {
      checkId('key prefix', keyPrefix)
      const doomed = (await store.listSourceItems(source)).filter((r) => r.externalKey === keyPrefix || r.externalKey.startsWith(`${keyPrefix}/`))
      const files = doomed.filter((r) => r.kind === 'file')
      for (const r of files) {
        const file = await store.getFile(r.itemId)
        if (file) {
          await dropGrants(source, 'file', file.id)
          await store.deleteFile(file.id)
          if (!(await store.blobInUse(file.sha256))) await blobs.remove(file.sha256)
        }
        await store.deleteSourceItem(source, r.externalKey)
      }
      // Folders deepest first, each empty by then (anything else inside is a bug: fail loud).
      const folders = doomed.filter((r) => r.kind === 'folder')
      const depth = new Map<string, number>()
      for (const r of folders) depth.set(r.itemId, (await chainIds(r.itemId)).length)
      folders.sort((a, b) => depth.get(b.itemId)! - depth.get(a.itemId)!)
      for (const r of folders) {
        const kids = await store.children(r.itemId)
        if (kids.folders.length > 0 || kids.files.length > 0) {
          throw new Error(`drive source ${source}: folder ${r.externalKey} still holds items outside ${keyPrefix}`)
        }
        await dropGrants(source, 'folder', r.itemId)
        await store.deleteFolder(r.itemId)
        await store.deleteSourceItem(source, r.externalKey)
      }
      return doomed.length
    },

    async list(source) {
      return (await store.listSourceItems(source)).map(toItem)
    },
  }

  /** Sharing an admin added below the root goes with the item (only then is there anything to drop). */
  async function dropGrants(source: string, type: 'folder' | 'file', id: string): Promise<void> {
    if ((await access.listGrants(type, id)).length > 0) await access.systemGrants(source, type, id, [])
  }
}
