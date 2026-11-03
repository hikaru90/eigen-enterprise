import type { AccessLevel, DriveAccessPort, Grant, GrantSubject } from './access-port'
import type { BlobStore } from './storage'
import type { DriveFile, DriveFolder, DriveRevision, DriveStore } from './store'
import { randomUUID } from 'node:crypto'
import { holderOf, isLive, LOCK_TTL_MS, type EditLockStore, type LockHolder } from './locks'
import { isRevisioned, isTextFile, mimeFor } from './preview'

/**
 * Drive: folders and files, sharing, trash and text revisions. Every read and
 * write checks access first, server side, and fails closed:
 * - the access contract decides (owner/admin always manage; grants on the
 *   item or a folder above it, via user, group or the whole company); a
 *   person who creates an item gets manage on it (initializeGrants), so the
 *   creator of a folder manages everything later put inside it;
 * - an item the actor can't view is "not found" (its existence is not leaked);
 *   one they can view but not change is "forbidden".
 * The agent (an `agent` actor) acts with admin rights, like the members.*
 * tools; its writes go through the kernel's approval gate.
 */

export type Actor = { kind: 'user'; userId: string } | { kind: 'agent'; id: string }
export type ItemType = 'folder' | 'file'

export class DriveError extends Error {
  constructor(
    readonly code: 'not_found' | 'forbidden' | 'invalid' | 'too_large' | 'locked',
    message: string,
    /** For `locked`: who holds the edit lock now. */
    readonly holder?: LockHolder & { name: string },
  ) {
    super(message)
  }
}

export type DriveDeps = {
  store: DriveStore
  blobs: BlobStore
  access: DriveAccessPort
  maxUploadBytes: number
  /** Edit locks (W-6): one editor session per Markdown/CSV file. */
  locks: EditLockStore
  lockTtlMs?: number
  now?: () => Date
}

/** What an editor session learns about a file's edit lock. */
export type LockView = { state: 'held'; since: Date } | { state: 'locked'; holder: LockHolder & { name: string } } | { state: 'free' }

export type ItemView = {
  type: ItemType
  id: string
  name: string
  parentId: string | null
  ownerId: string
  updatedAt: Date
  trashedAt: Date | null
  size?: number
  mime?: string
  /** What the actor may do with it (set on listings; the server checks again on every act). */
  canEdit?: boolean
  canManage?: boolean
}

export type Crumb = { id: string; name: string }
/** Where a path starts: "My drive", "Shared with me" or "Messages" (a conversation's attachment folder). */
export type PathRoot = { label: string; href: string }

/** The owner id of the folders Messages keeps attachments in (its system actor). */
export const MESSAGES_SYSTEM_OWNER = 'messages'

/** A revision as listed: `restoredFrom` names the earlier revision a restore brought back. */
export type ListedRevision = DriveRevision & { restoredFrom?: { id: string; authorId: string; createdAt: Date } }

/**
 * Revisions as people see them (newest first): the empty first version of a
 * new document is not history worth restoring (older data still has one), and
 * a revision whose content equals an earlier, non-adjacent one is a restore of it.
 */
export function presentRevisions(revs: DriveRevision[]): ListedRevision[] {
  const list = revs.length > 0 && revs[revs.length - 1]!.size === 0 ? revs.slice(0, -1) : revs
  return list.map((r, i) => {
    const from = list.slice(i + 2).find((o) => o.sha256 === r.sha256)
    return from ? { ...r, restoredFrom: { id: from.id, authorId: from.authorId, createdAt: from.createdAt } } : r
  })
}

export const DEFAULT_MAX_UPLOAD_BYTES = 100 * 1024 * 1024

/** DRIVE_MAX_UPLOAD_BYTES when set (must be a positive integer, else refuse), else 100 MB. */
export function resolveMaxUploadBytes(env: Record<string, string | undefined>): number {
  const raw = env.DRIVE_MAX_UPLOAD_BYTES?.trim()
  if (!raw) return DEFAULT_MAX_UPLOAD_BYTES
  const n = Number(raw)
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`DRIVE_MAX_UPLOAD_BYTES must be a positive whole number of bytes, got "${raw}"`)
  return n
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v >= 10 ? Math.round(v) : v.toFixed(1)} ${units[i]}`
}

function cleanName(raw: string): string {
  const name = raw.trim()
  if (!name) throw new DriveError('invalid', 'Give it a name.')
  if (name.length > 255) throw new DriveError('invalid', 'That name is too long (255 characters at most).')
  if (/[/\\]/.test(name) || name === '.' || name === '..') throw new DriveError('invalid', 'A name can’t contain / or \\.')
  return name
}

const folderView = (f: DriveFolder): ItemView => ({
  type: 'folder',
  id: f.id,
  name: f.name,
  parentId: f.parentId,
  ownerId: f.ownerId,
  updatedAt: f.updatedAt,
  trashedAt: f.trashedAt,
})
const fileView = (f: DriveFile): ItemView => ({
  type: 'file',
  id: f.id,
  name: f.name,
  parentId: f.folderId,
  ownerId: f.ownerId,
  updatedAt: f.updatedAt,
  trashedAt: f.trashedAt,
  size: f.size,
  mime: f.mime,
})
const byName = (a: ItemView, b: ItemView) => a.name.localeCompare(b.name)

export function createDriveService(deps: DriveDeps) {
  const { store, blobs, access, locks } = deps
  const now = deps.now ?? (() => new Date())
  const lockTtl = deps.lockTtlMs ?? LOCK_TTL_MS

  async function personName(userId: string): Promise<string> {
    const p = (await access.shareTargets()).people.find((x) => x.id === userId)
    return p ? p.name || p.email : 'Someone'
  }
  async function namedHolder(lock: Parameters<typeof holderOf>[0]) {
    return { ...holderOf(lock), name: await personName(lock.userId) }
  }

  async function requireEditable(actor: Actor, id: string): Promise<DriveFile> {
    const file = await requireFile(actor, id, 'edit')
    if (!isRevisioned(file.name)) throw new DriveError('invalid', `Only Markdown (.md) and table (.csv) files are edited in place; “${file.name}” is not one.`)
    return file
  }

  /**
   * A write must not cut across someone else's editing session. With a
   * session id the writer must hold the lock (or reclaim a stale/free one);
   * without one (the agent, API calls) the file must not be locked by a
   * live session.
   */
  async function requireWriteTurn(actor: Actor, fileId: string, sessionId: string | undefined): Promise<void> {
    const at = now()
    const cur = await locks.get(fileId)
    if (sessionId) {
      if (cur && cur.sessionId === sessionId) {
        if (await locks.touch(fileId, sessionId, at)) return
      } else if (!isLive(cur, at, lockTtl)) {
        const got = await locks.claim(
          { fileId, userId: ownerIdOf(actor), sessionId, acquiredAt: at, heartbeatAt: at },
          { staleBefore: new Date(at.getTime() - lockTtl), force: false },
        )
        if (got.sessionId === sessionId) return
      }
      const now2 = await locks.get(fileId)
      const holder = now2 ? await namedHolder(now2) : undefined
      throw new DriveError('locked', `${holder?.name ?? 'Someone'} took over editing; your changes were not saved.`, holder)
    }
    if (isLive(cur, at, lockTtl)) {
      const holder = await namedHolder(cur)
      throw new DriveError('locked', `${holder.name} is editing this file right now; try again when they are done.`, holder)
    }
  }

  /** The folders above a parent id, nearest first (the parent itself included). */
  async function chainFrom(parentId: string | null): Promise<DriveFolder[]> {
    const out: DriveFolder[] = []
    const seen = new Set<string>()
    let id = parentId
    while (id) {
      if (seen.has(id)) throw new Error(`drive folder cycle at ${id}`)
      seen.add(id)
      const f = await store.getFolder(id)
      if (!f) throw new Error(`drive folder ${id} is missing from its child's chain`)
      out.push(f)
      id = f.parentId
    }
    return out
  }

  async function load(type: ItemType, id: string): Promise<DriveFolder | DriveFile | null> {
    return type === 'folder' ? store.getFolder(id) : store.getFile(id)
  }
  const parentOf = (item: DriveFolder | DriveFile) => ('parentId' in item ? item.parentId : item.folderId)

  async function allows(actor: Actor, type: ItemType, item: DriveFolder | DriveFile, level: AccessLevel): Promise<boolean> {
    if (actor.kind === 'agent') return true
    const chain = await chainFrom(parentOf(item))
    return access.canAccess(actor.userId, { resourceType: type, resourceId: item.id, folderChain: chain.map((f) => f.id) }, level)
  }

  /** Loads an item the actor holds `level` on; trashed items only when `trashed` is set. */
  async function requireItem(actor: Actor, type: ItemType, id: string, level: AccessLevel, opts: { trashed?: boolean } = {}) {
    const item = await load(type, id)
    if (!item || !(await allows(actor, type, item, 'view'))) throw new DriveError('not_found', `No such ${type}.`)
    if (!opts.trashed && (item.trashedAt || (await inTrash(parentOf(item))))) throw new DriveError('not_found', `That ${type} is in the trash.`)
    if (level !== 'view' && !(await allows(actor, type, item, level))) {
      throw new DriveError('forbidden', level === 'manage' ? `You can’t manage this ${type}.` : `You can view this ${type} but not change it.`)
    }
    return item
  }

  async function inTrash(parentId: string | null): Promise<boolean> {
    return (await chainFrom(parentId)).some((f) => f.trashedAt !== null)
  }

  async function requireFolder(actor: Actor, id: string, level: AccessLevel): Promise<DriveFolder> {
    return (await requireItem(actor, 'folder', id, level)) as DriveFolder
  }
  async function requireFile(actor: Actor, id: string, level: AccessLevel): Promise<DriveFile> {
    return (await requireItem(actor, 'file', id, level)) as DriveFile
  }

  /** Where new items may go: the top level (each person's own My drive) or a folder they can edit. */
  async function requireTarget(actor: Actor, folderId: string | null): Promise<void> {
    if (folderId !== null) await requireFolder(actor, folderId, 'edit')
  }

  const ownerIdOf = (actor: Actor) => (actor.kind === 'user' ? actor.userId : actor.id)

  const MY_DRIVE: PathRoot = { label: 'My drive', href: '/drive' }
  const SHARED: PathRoot = { label: 'Shared with me', href: '/drive/shared' }
  const MESSAGES: PathRoot = { label: 'Messages', href: '/messages' }

  /**
   * The path to an item as the actor may see it: ancestors they can't open
   * are left out, and the root names whose tree it is — "My drive" only for
   * the actor's own, "Messages" for conversation attachments, else
   * "Shared with me".
   */
  async function pathFor(actor: Actor, chain: DriveFolder[], item: DriveFolder | DriveFile): Promise<{ root: PathRoot; path: Crumb[] }> {
    let start = 0
    while (start < chain.length && !(await allows(actor, 'folder', chain[start]!, 'view'))) start++
    let visibleChain = chain.slice(start)
    const top = visibleChain[0] ?? item
    let root: PathRoot
    if (top.ownerId === MESSAGES_SYSTEM_OWNER) {
      root = MESSAGES
      // The "Messages" folder itself is the root crumb, not a step after it.
      if (visibleChain[0] && visibleChain[0].parentId === null) visibleChain = visibleChain.slice(1)
    } else root = actor.kind === 'user' && top.ownerId === actor.userId ? MY_DRIVE : actor.kind === 'agent' ? MY_DRIVE : SHARED
    return { root, path: visibleChain.map((f) => ({ id: f.id, name: f.name })) }
  }

  /** The revision this editor session already started (same lock tenure, same author, not a restore), if any. */
  async function sessionRevision(actor: Actor, fileId: string, sessionId: string): Promise<DriveRevision | null> {
    const lock = await locks.get(fileId)
    if (!lock || lock.sessionId !== sessionId) return null
    const revs = presentRevisions(await store.listRevisions(fileId))
    const latest = revs[0]
    if (!latest || latest.restoredFrom || latest.authorId !== ownerIdOf(actor)) return null
    return latest.createdAt.getTime() >= lock.acquiredAt.getTime() ? latest : null
  }

  async function storeRevision(fileId: string, sha256: string, size: number, actor: Actor, at: Date): Promise<DriveRevision> {
    const rev: DriveRevision = { id: randomUUID(), fileId, sha256, size, authorId: ownerIdOf(actor), createdAt: at }
    await store.insertRevision(rev)
    return rev
  }

  async function addFile(actor: Actor, folderId: string | null, rawName: string, bytes: Uint8Array, mime: string | null): Promise<DriveFile> {
    const name = cleanName(rawName)
    if (bytes.byteLength > deps.maxUploadBytes) {
      throw new DriveError('too_large', `“${name}” is ${formatBytes(bytes.byteLength)}; files can be at most ${formatBytes(deps.maxUploadBytes)}.`)
    }
    await requireTarget(actor, folderId)
    const blob = await blobs.put(bytes)
    const at = now()
    const file: DriveFile = {
      id: randomUUID(),
      folderId,
      name,
      ownerId: ownerIdOf(actor),
      mime: mimeFor(name, mime),
      size: blob.size,
      sha256: blob.sha256,
      createdAt: at,
      updatedAt: at,
      trashedAt: null,
    }
    await store.insertFile(file)
    await grantCreator(actor, 'file', file.id)
    // A new empty document has no history yet: its first revision is its first save.
    if (isRevisioned(name) && blob.size > 0) await storeRevision(file.id, blob.sha256, blob.size, actor, at)
    return file
  }

  /** The person who creates an item manages it (the agent's items are managed by the owner and admins). */
  async function grantCreator(actor: Actor, type: ItemType, id: string): Promise<void> {
    if (actor.kind !== 'user') return
    await access.initializeGrants(actor.userId, type, id, [
      { resourceType: type, resourceId: id, subject: { kind: 'user', userId: actor.userId }, level: 'manage' },
    ])
  }

  async function dropBlobIfUnused(sha: string): Promise<void> {
    if (!(await store.blobInUse(sha))) await blobs.remove(sha)
  }

  async function purgeFile(actor: Actor, file: DriveFile): Promise<void> {
    const shas = new Set([file.sha256, ...(await store.listRevisions(file.id)).map((r) => r.sha256)])
    await access.dropResource(ownerIdOf(actor), 'file', file.id, (await chainFrom(file.folderId)).map((f) => f.id))
    await store.deleteFile(file.id)
    for (const sha of shas) await dropBlobIfUnused(sha)
  }

  async function purgeFolder(actor: Actor, folder: DriveFolder): Promise<void> {
    const kids = await store.children(folder.id)
    for (const f of kids.files) await purgeFile(actor, f)
    for (const f of kids.folders) await purgeFolder(actor, f)
    await access.dropResource(ownerIdOf(actor), 'folder', folder.id, (await chainFrom(folder.parentId)).map((f) => f.id))
    await store.deleteFolder(folder.id)
  }

  async function visible(actor: Actor, items: { folders: DriveFolder[]; files: DriveFile[] }, level: AccessLevel = 'view') {
    const out: ItemView[] = []
    const withRights = async (type: ItemType, f: DriveFolder | DriveFile, v: ItemView) => ({
      ...v,
      canEdit: await allows(actor, type, f, 'edit'),
      canManage: await allows(actor, type, f, 'manage'),
    })
    for (const f of items.folders) if (!f.trashedAt && !(await inTrash(f.parentId)) && (await allows(actor, 'folder', f, level))) out.push(await withRights('folder', f, folderView(f)))
    for (const f of items.files) if (!f.trashedAt && !(await inTrash(f.folderId)) && (await allows(actor, 'file', f, level))) out.push(await withRights('file', f, fileView(f)))
    return out
  }

  const sorted = (items: ItemView[]) => [...items.filter((i) => i.type === 'folder').sort(byName), ...items.filter((i) => i.type === 'file').sort(byName)]

  return {
    /** A folder's contents (null = the actor's own top level), with the path to it and what the actor may do there. */
    async listFolder(actor: Actor, folderId: string | null) {
      if (folderId === null) {
        const kids = await store.children(null)
        const mine = (f: { ownerId: string }) => actor.kind === 'agent' || f.ownerId === actor.userId
        const items = await visible(actor, { folders: kids.folders.filter(mine), files: kids.files.filter(mine) })
        return { folder: null, path: [] as Crumb[], root: MY_DRIVE, items: sorted(items), canEdit: true, canManage: false }
      }
      const folder = await requireFolder(actor, folderId, 'view')
      const { root, path } = await pathFor(actor, (await chainFrom(folder.id)).reverse(), folder)
      return {
        folder: folderView(folder),
        path,
        root,
        items: sorted(await visible(actor, await store.children(folder.id))),
        canEdit: await allows(actor, 'folder', folder, 'edit'),
        canManage: await allows(actor, 'folder', folder, 'manage'),
      }
    },

    /** Items other people shared with the actor: the top-most ones they can view (a shared folder, not each file in it). */
    async sharedWithMe(actor: Actor): Promise<ItemView[]> {
      if (actor.kind !== 'user') return []
      const all = await visible(actor, await store.findByName(''))
      const viewable = new Set(all.map((i) => `${i.type}:${i.id}`))
      return sorted(all.filter((i) => i.ownerId !== actor.userId && !(i.parentId && viewable.has(`folder:${i.parentId}`))))
    },

    async search(actor: Actor, query: string): Promise<ItemView[]> {
      const q = query.trim()
      if (!q) return []
      return sorted(await visible(actor, await store.findByName(q)))
    },

    /** Trashed items the actor can change (only the item that was trashed, not what's inside it). */
    async trash(actor: Actor): Promise<ItemView[]> {
      const all = await store.findByName('')
      const out: ItemView[] = []
      for (const f of all.folders) {
        if (f.trashedAt && (await allows(actor, 'folder', f, 'edit'))) out.push({ ...folderView(f), canEdit: true, canManage: await allows(actor, 'folder', f, 'manage') })
      }
      for (const f of all.files) {
        if (f.trashedAt && (await allows(actor, 'file', f, 'edit'))) out.push({ ...fileView(f), canEdit: true, canManage: await allows(actor, 'file', f, 'manage') })
      }
      return out.sort((a, b) => (b.trashedAt?.getTime() ?? 0) - (a.trashedAt?.getTime() ?? 0))
    },

    async createFolder(actor: Actor, parentId: string | null, rawName: string): Promise<ItemView> {
      const name = cleanName(rawName)
      await requireTarget(actor, parentId)
      const at = now()
      const folder: DriveFolder = { id: randomUUID(), parentId, name, ownerId: ownerIdOf(actor), createdAt: at, updatedAt: at, trashedAt: null }
      await store.insertFolder(folder)
      await grantCreator(actor, 'folder', folder.id)
      return folderView(folder)
    },

    async upload(actor: Actor, folderId: string | null, file: { name: string; bytes: Uint8Array; mime: string | null }): Promise<ItemView> {
      return fileView(await addFile(actor, folderId, file.name, file.bytes, file.mime))
    },

    /** New → Document (.md) / Table (.csv): an empty file, its first revision stored. */
    async createDocument(actor: Actor, folderId: string | null, kind: 'md' | 'csv', rawName?: string): Promise<ItemView> {
      const base = rawName?.trim() || (kind === 'md' ? 'Untitled document' : 'Untitled table')
      const name = base.toLowerCase().endsWith(`.${kind}`) ? base : `${base}.${kind}`
      return fileView(await addFile(actor, folderId, name, new Uint8Array(), kind === 'md' ? 'text/markdown' : 'text/csv'))
    },

    async rename(actor: Actor, type: ItemType, id: string, rawName: string): Promise<ItemView> {
      const name = cleanName(rawName)
      await requireItem(actor, type, id, 'edit')
      if (type === 'folder') await store.updateFolder(id, { name, updatedAt: now() })
      else await store.updateFile(id, { name, updatedAt: now() })
      return view(type, id)
    },

    async move(actor: Actor, type: ItemType, id: string, targetFolderId: string | null): Promise<ItemView> {
      await requireItem(actor, type, id, 'edit')
      await requireTarget(actor, targetFolderId)
      if (type === 'folder' && targetFolderId !== null) {
        const chain = [targetFolderId, ...(await chainFrom(targetFolderId)).map((f) => f.id)]
        if (chain.includes(id)) throw new DriveError('invalid', 'A folder can’t move into itself.')
      }
      if (type === 'folder') await store.updateFolder(id, { parentId: targetFolderId, updatedAt: now() })
      else await store.updateFile(id, { folderId: targetFolderId, updatedAt: now() })
      return view(type, id)
    },

    async moveToTrash(actor: Actor, type: ItemType, id: string): Promise<void> {
      await requireItem(actor, type, id, 'edit')
      if (type === 'folder') await store.updateFolder(id, { trashedAt: now() })
      else await store.updateFile(id, { trashedAt: now() })
    },

    /** Back from the trash; to the top level when the folder it was in is itself in the trash. */
    async restore(actor: Actor, type: ItemType, id: string): Promise<ItemView> {
      const item = await requireItem(actor, type, id, 'edit', { trashed: true })
      if (!item.trashedAt) throw new DriveError('invalid', `That ${type} is not in the trash.`)
      const orphan = await inTrash(parentOf(item))
      if (type === 'folder') await store.updateFolder(id, { trashedAt: null, ...(orphan ? { parentId: null } : {}) })
      else await store.updateFile(id, { trashedAt: null, ...(orphan ? { folderId: null } : {}) })
      return view(type, id)
    },

    /** Deletes a trashed item and everything in it, for good. Needs manage (the owner and admins always have it). */
    async deleteForever(actor: Actor, type: ItemType, id: string): Promise<void> {
      const item = await requireItem(actor, type, id, 'manage', { trashed: true })
      if (!item.trashedAt) throw new DriveError('invalid', 'Move it to the trash first.')
      if (type === 'folder') await purgeFolder(actor, item as DriveFolder)
      else await purgeFile(actor, item as DriveFile)
    },

    async fileInfo(actor: Actor, id: string) {
      const file = await requireFile(actor, id, 'view')
      const { root, path } = await pathFor(actor, file.folderId ? (await chainFrom(file.folderId)).reverse() : [], file)
      return {
        file: fileView(file),
        path,
        root,
        canEdit: await allows(actor, 'file', file, 'edit'),
        canManage: await allows(actor, 'file', file, 'manage'),
      }
    },

    async readFile(actor: Actor, id: string): Promise<{ file: DriveFile; bytes: Uint8Array }> {
      const file = await requireFile(actor, id, 'view')
      return { file, bytes: await blobs.get(file.sha256) }
    },

    async readText(actor: Actor, id: string): Promise<{ file: ItemView; content: string }> {
      const file = await requireFile(actor, id, 'view')
      if (!isTextFile(file.name, file.mime)) throw new DriveError('invalid', `“${file.name}” is not a text file.`)
      return { file: fileView(file), content: new TextDecoder().decode(await blobs.get(file.sha256)) }
    },

    /**
     * Saves new text into a Markdown/CSV file. One revision per editing
     * session: saves under the same edit lock fold into the revision that
     * session started (a take-over, a new session after the lock was let go,
     * or a restore starts a new one).
     */
    async writeText(actor: Actor, id: string, content: string, sessionId?: string): Promise<{ file: ItemView; revision: DriveRevision }> {
      const file = await requireFile(actor, id, 'edit')
      if (!isRevisioned(file.name)) throw new DriveError('invalid', `Only Markdown (.md) and table (.csv) files are written as text; “${file.name}” is not one.`)
      await requireWriteTurn(actor, id, sessionId)
      const bytes = new TextEncoder().encode(content)
      if (bytes.byteLength > deps.maxUploadBytes) throw new DriveError('too_large', `That text is ${formatBytes(bytes.byteLength)}; files can be at most ${formatBytes(deps.maxUploadBytes)}.`)
      const blob = await blobs.put(bytes)
      const at = now()
      await store.updateFile(id, { sha256: blob.sha256, size: blob.size, updatedAt: at })
      const ongoing = sessionId ? await sessionRevision(actor, id, sessionId) : null
      let revision: DriveRevision
      if (ongoing) {
        await store.updateRevision(ongoing.id, { sha256: blob.sha256, size: blob.size, createdAt: at })
        revision = { ...ongoing, sha256: blob.sha256, size: blob.size, createdAt: at }
      } else revision = await storeRevision(id, blob.sha256, blob.size, actor, at)
      return { file: await view('file', id), revision }
    },

    async listRevisions(actor: Actor, id: string): Promise<ListedRevision[]> {
      await requireFile(actor, id, 'view')
      return presentRevisions(await store.listRevisions(id))
    },

    /** Restoring a revision saves its text again as the newest revision (history is never rewritten). */
    async restoreRevision(actor: Actor, id: string, revisionId: string, sessionId?: string): Promise<{ file: ItemView; revision: DriveRevision }> {
      const file = await requireFile(actor, id, 'edit')
      const rev = await store.getRevision(revisionId)
      if (!rev || rev.fileId !== file.id) throw new DriveError('not_found', 'No such revision.')
      await requireWriteTurn(actor, id, sessionId)
      const at = now()
      await store.updateFile(id, { sha256: rev.sha256, size: rev.size, updatedAt: at })
      const revision = await storeRevision(id, rev.sha256, rev.size, actor, at)
      return { file: await view('file', id), revision }
    },

    /** The text of one revision (viewing an older version). */
    async readRevision(actor: Actor, id: string, revisionId: string): Promise<{ revision: DriveRevision; content: string }> {
      const file = await requireFile(actor, id, 'view')
      const rev = await store.getRevision(revisionId)
      if (!rev || rev.fileId !== file.id) throw new DriveError('not_found', 'No such revision.')
      return { revision: rev, content: new TextDecoder().decode(await blobs.get(rev.sha256)) }
    },

    /** Who is editing (view access is enough to ask). */
    async lockStatus(actor: Actor, id: string): Promise<LockView> {
      await requireFile(actor, id, 'view')
      const cur = await locks.get(id)
      return isLive(cur, now(), lockTtl) ? { state: 'locked', holder: await namedHolder(cur) } : { state: 'free' }
    },

    /** Opens a file for editing: takes the lock unless another live session holds it (`takeover` takes it anyway). */
    async acquireLock(actor: Actor, id: string, sessionId: string, opts: { takeover?: boolean } = {}): Promise<LockView> {
      await requireEditable(actor, id)
      const at = now()
      const got = await locks.claim(
        { fileId: id, userId: ownerIdOf(actor), sessionId, acquiredAt: at, heartbeatAt: at },
        { staleBefore: new Date(at.getTime() - lockTtl), force: !!opts.takeover },
      )
      return got.sessionId === sessionId ? { state: 'held', since: got.acquiredAt } : { state: 'locked', holder: await namedHolder(got) }
    },

    /** Keeps a held lock alive; `locked` means someone took over (or it went stale and was taken). */
    async heartbeatLock(actor: Actor, id: string, sessionId: string): Promise<LockView> {
      await requireEditable(actor, id)
      const at = now()
      if (await locks.touch(id, sessionId, at)) {
        const cur = await locks.get(id)
        return { state: 'held', since: cur?.acquiredAt ?? at }
      }
      const cur = await locks.get(id)
      return cur ? { state: 'locked', holder: await namedHolder(cur) } : { state: 'free' }
    },

    async releaseLock(actor: Actor, id: string, sessionId: string): Promise<void> {
      await requireFile(actor, id, 'view')
      await locks.release(id, sessionId)
    },

    async getGrants(actor: Actor, type: ItemType, id: string): Promise<Grant[]> {
      await requireItem(actor, type, id, 'manage')
      return access.listGrants(type, id)
    },

    async setGrants(actor: Actor, type: ItemType, id: string, entries: Array<{ subject: GrantSubject; level: AccessLevel }>): Promise<Grant[]> {
      const item = await requireItem(actor, type, id, 'manage')
      const seen = new Set<string>()
      const grants: Grant[] = []
      for (const e of entries) {
        const key = e.subject.kind === 'user' ? `u:${e.subject.userId}` : e.subject.kind === 'group' ? `g:${e.subject.groupId}` : 'c'
        if (seen.has(key)) throw new DriveError('invalid', 'Each person or group can be named once.')
        seen.add(key)
        grants.push({ resourceType: type, resourceId: id, subject: e.subject, level: e.level })
      }
      try {
        await access.setGrants(ownerIdOf(actor), type, id, grants, (await chainFrom(parentOf(item))).map((f) => f.id))
      } catch (err) {
        // The contract's validation (no such member/group): a plain sentence for the dialog.
        if (err instanceof Error && (err as { code?: string }).code === 'invalid_grant') throw new DriveError('invalid', err.message)
        throw err
      }
      return access.listGrants(type, id)
    },

    shareTargets: () => access.shareTargets(),

    storageBytes: () => store.storageBytes(),
  }

  async function view(type: ItemType, id: string): Promise<ItemView> {
    const item = await load(type, id)
    if (!item) throw new Error(`drive ${type} ${id} vanished`)
    return type === 'folder' ? folderView(item as DriveFolder) : fileView(item as DriveFile)
  }
}

export type DriveService = ReturnType<typeof createDriveService>
