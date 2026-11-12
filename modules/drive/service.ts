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
 *
 * Archive (migration 0126) is a state, not a place: an archived item stays in
 * its folder with its sharing, leaves the normal listings (a folder's
 * contents, My drive, Shared with me, Messages), and shows in the Archived
 * view, in search (marked) and when opened directly. Whoever can edit an item
 * can archive and unarchive it.
 *
 * Source folders (migration 0133, plan/github-drive.md §5) are read-only
 * copies a source plugin writes through the system writer (source-writer.ts):
 * nobody edits them, the agent included; owner and admins can still share
 * them. They have their own rail section (named by their root folder) and
 * stay out of Shared with me and archive suggestions.
 */

export type Actor = { kind: 'user'; userId: string } | { kind: 'agent'; id: string }
export type ItemType = 'folder' | 'file'

export class DriveError extends Error {
  constructor(
    /** `unavailable`: no AI provider for the company; `upstream`: the provider failed or answered unreadably. */
    readonly code: 'not_found' | 'forbidden' | 'invalid' | 'too_large' | 'locked' | 'unavailable' | 'upstream',
    message: string,
    /** For `locked`: who holds the edit lock now. */
    readonly holder?: LockHolder & { name: string },
    options?: { cause?: unknown },
  ) {
    super(message, options)
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
  /** Set when this item itself is archived (by: a member id or the agent's id). */
  archivedAt: Date | null
  archivedBy: string | null
  /** Search results only: archived itself, or inside an archived folder the actor can open. */
  inArchive?: boolean
  size?: number
  mime?: string
  /** What the actor may do with it (set on listings; the server checks again on every act). */
  canEdit?: boolean
  canManage?: boolean
}

/**
 * A listing row's owner and sharing state (see describeItems); `readOnlyFrom`
 * names the source (its root folder's name) a read-only source item comes from.
 */
export type ItemDescription = { ownerName: string | null; shared: boolean | null; readOnlyFrom: string | null }

/** A source's root folder as the Drive rail lists it (its own section). */
export type SourceRootView = { source: string; folderId: string; name: string; href: string }

export type Crumb = { id: string; name: string }
/** Where a path starts: "My drive", "Shared with me" or "Messages" (a conversation's attachment folder). */
export type PathRoot = { label: string; href: string }

/** One folder's archived items as the Archived view shows them (see `archived`). */
export type ArchiveGroup = {
  key: string
  /** The folder they are in, when the actor can open it (null: the top level, or a folder they can't see). */
  folder: Crumb | null
  root: PathRoot
  path: Crumb[]
  items: Array<ItemView & { archivedByName: string | null }>
}

/** A file "suggest what to archive" may put to the model: plain facts only. */
export type ArchiveCandidate = {
  file: ItemView
  createdAt: Date
  root: PathRoot
  path: Crumb[]
  /** The folder it is in: how many live files sit there, and when the newest of them changed. */
  folder: { files: number; newestChange: Date }
}

/** A batch archive/unarchive names items by type and id; each one it couldn't do gets a plain sentence. */
export type ItemRef = { type: ItemType; id: string }
export type BatchError = ItemRef & { error: string }

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
  archivedAt: f.archivedAt,
  archivedBy: f.archivedBy,
})
const fileView = (f: DriveFile): ItemView => ({
  type: 'file',
  id: f.id,
  name: f.name,
  parentId: f.folderId,
  ownerId: f.ownerId,
  updatedAt: f.updatedAt,
  trashedAt: f.trashedAt,
  archivedAt: f.archivedAt,
  archivedBy: f.archivedBy,
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

  /**
   * The source root an item belongs to (itself, or the top of its chain), or
   * null for what people make. `chain` is nearest first. Source roots are
   * top-level folders, so the root is the chain's last folder.
   */
  function sourceRootOf(item: DriveFolder | DriveFile, chain: readonly DriveFolder[]): DriveFolder | null {
    const top = chain[chain.length - 1] ?? item
    if (top.source !== null && 'parentId' in top && top.parentId === null) return top
    if (item.source !== null || chain.some((f) => f.source !== null)) throw new Error(`drive ${item.id} is a source item outside its source's root`)
    return null
  }

  const readOnlyMessage = (root: DriveFolder) => `This comes from ${root.name} and is read-only here. Change it on ${root.name}.`

  /**
   * Source items are read-only for everyone, the agent included (checked
   * before its bypass): no edit at all; manage stays (sharing, for the owner
   * and admins); the access contract decides the rest.
   */
  async function allows(actor: Actor, type: ItemType, item: DriveFolder | DriveFile, level: AccessLevel): Promise<boolean> {
    const chain = await chainFrom(parentOf(item))
    if (level === 'edit' && sourceRootOf(item, chain)) return false
    if (actor.kind === 'agent') return true
    return access.canAccess(actor.userId, { resourceType: type, resourceId: item.id, folderChain: chain.map((f) => f.id) }, level)
  }

  /** Loads an item the actor holds `level` on; trashed items only when `trashed` is set. */
  async function requireItem(actor: Actor, type: ItemType, id: string, level: AccessLevel, opts: { trashed?: boolean } = {}) {
    const item = await load(type, id)
    if (!item || !(await allows(actor, type, item, 'view'))) throw new DriveError('not_found', `No such ${type}.`)
    if (!opts.trashed && (item.trashedAt || (await inTrash(parentOf(item))))) throw new DriveError('not_found', `That ${type} is in the trash.`)
    if (level === 'edit') {
      const root = sourceRootOf(item, await chainFrom(parentOf(item)))
      if (root) throw new DriveError('forbidden', readOnlyMessage(root))
    }
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
  /** A source folder's tree starts at its root folder (named by the source, e.g. "GitHub"). */
  const sourcePathRoot = (root: DriveFolder): PathRoot => ({ label: root.name, href: `/drive/folder/${root.id}` })

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
    const source = sourceRootOf(item, [...chain].reverse())
    if (source && (source.id === item.id || visibleChain[0]?.id === source.id)) {
      // A source folder is its own rail section; its root is the root crumb, not a step after it.
      // (Shared below a root the actor can't open, it reads as "Shared with me".)
      root = sourcePathRoot(source)
      if (visibleChain[0]?.id === source.id) visibleChain = visibleChain.slice(1)
    } else if (top.ownerId === MESSAGES_SYSTEM_OWNER) {
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
      archivedAt: null,
      archivedBy: null,
      source: null,
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

  /** What the actor can view of these items, with their rights; archived ones only with `archived: 'include'`. */
  async function visible(actor: Actor, items: { folders: DriveFolder[]; files: DriveFile[] }, opts: { archived: 'hide' | 'include' }) {
    const out: ItemView[] = []
    const withRights = async (type: ItemType, f: DriveFolder | DriveFile, v: ItemView) => ({
      ...v,
      canEdit: await allows(actor, type, f, 'edit'),
      canManage: await allows(actor, type, f, 'manage'),
    })
    const shown = (f: DriveFolder | DriveFile) => !f.trashedAt && (opts.archived === 'include' || !f.archivedAt)
    for (const f of items.folders) if (shown(f) && !(await inTrash(f.parentId)) && (await allows(actor, 'folder', f, 'view'))) out.push(await withRights('folder', f, folderView(f)))
    for (const f of items.files) if (shown(f) && !(await inTrash(f.folderId)) && (await allows(actor, 'file', f, 'view'))) out.push(await withRights('file', f, fileView(f)))
    return out
  }

  /** The nearest folder from parentId up that is archived and that the actor can open, if any. */
  async function archivedAbove(actor: Actor, parentId: string | null): Promise<Crumb | null> {
    for (const f of await chainFrom(parentId)) {
      if (f.archivedAt && (await allows(actor, 'folder', f, 'view'))) return { id: f.id, name: f.name }
    }
    return null
  }

  async function setArchived(actor: Actor, type: ItemType, id: string, archived: boolean): Promise<DriveFolder | DriveFile> {
    const item = await requireItem(actor, type, id, 'edit')
    if (archived && item.archivedAt) throw new DriveError('invalid', `“${item.name}” is already archived.`)
    if (!archived && !item.archivedAt) throw new DriveError('invalid', `“${item.name}” is not archived.`)
    const patch = archived ? { archivedAt: now(), archivedBy: ownerIdOf(actor) } : { archivedAt: null, archivedBy: null }
    if (type === 'folder') await store.updateFolder(id, patch)
    else await store.updateFile(id, patch)
    return item
  }

  /** Runs an act per item: a DriveError becomes that item's sentence; anything else is a real failure. */
  async function eachItem<T>(items: readonly ItemRef[], act: (ref: ItemRef) => Promise<T>): Promise<{ done: T[]; errors: BatchError[] }> {
    const done: T[] = []
    const errors: BatchError[] = []
    for (const ref of items) {
      try {
        done.push(await act(ref))
      } catch (err) {
        if (!(err instanceof DriveError)) throw err
        errors.push({ type: ref.type, id: ref.id, error: err.message })
      }
    }
    return { done, errors }
  }

  const sorted = (items: ItemView[]) => [...items.filter((i) => i.type === 'folder').sort(byName), ...items.filter((i) => i.type === 'file').sort(byName)]

  return {
    /** A folder's contents (null = the actor's own top level), with the path to it and what the actor may do there. */
    async listFolder(actor: Actor, folderId: string | null) {
      if (folderId === null) {
        const kids = await store.children(null)
        const mine = (f: { ownerId: string }) => actor.kind === 'agent' || f.ownerId === actor.userId
        const items = await visible(actor, { folders: kids.folders.filter(mine), files: kids.files.filter(mine) }, { archived: 'hide' })
        return { folder: null, path: [] as Crumb[], root: MY_DRIVE, items: sorted(items), canEdit: true, canManage: false, archivedIn: null as Crumb | null }
      }
      const folder = await requireFolder(actor, folderId, 'view')
      const { root, path } = await pathFor(actor, (await chainFrom(folder.id)).reverse(), folder)
      return {
        folder: folderView(folder),
        path,
        root,
        items: sorted(await visible(actor, await store.children(folder.id), { archived: 'hide' })),
        canEdit: await allows(actor, 'folder', folder, 'edit'),
        canManage: await allows(actor, 'folder', folder, 'manage'),
        /** The archived folder above this one, when it sits inside one (the folder itself: `folder.archivedAt`). */
        archivedIn: await archivedAbove(actor, folder.parentId),
      }
    },

    /** Items other people shared with the actor: the top-most ones they can view (a shared folder, not each file in it). */
    async sharedWithMe(actor: Actor): Promise<ItemView[]> {
      if (actor.kind !== 'user') return []
      // Top-most is decided over everything viewable, archived included: the
      // contents of an archived shared folder don't surface on their own.
      // Source folders have their own rail section, so they are not listed here.
      const everything = await store.findByName('')
      const people = { folders: everything.folders.filter((f) => f.source === null), files: everything.files.filter((f) => f.source === null) }
      const all = await visible(actor, people, { archived: 'include' })
      const viewable = new Set(all.map((i) => `${i.type}:${i.id}`))
      return sorted(all.filter((i) => !i.archivedAt && i.ownerId !== actor.userId && !(i.parentId && viewable.has(`folder:${i.parentId}`))))
    },

    /** The source roots the actor can open, for the Drive rail (one section each), by name. */
    async sourceRoots(actor: Actor): Promise<SourceRootView[]> {
      const out: SourceRootView[] = []
      for (const r of await store.sourceRoots()) {
        if (r.trashedAt || r.source === null || !(await allows(actor, 'folder', r, 'view'))) continue
        out.push({ source: r.source, folderId: r.id, name: r.name, href: sourcePathRoot(r).href })
      }
      return out.sort((a, b) => a.name.localeCompare(b.name))
    },

    /** Messages: the conversation attachment folders (inside the Messages folder) the actor can open. */
    async messagesFolders(actor: Actor): Promise<ItemView[]> {
      const top = await store.children(null)
      const out: ItemView[] = []
      for (const root of top.folders) {
        if (root.ownerId !== MESSAGES_SYSTEM_OWNER || root.trashedAt) continue
        const kids = await store.children(root.id)
        out.push(...(await visible(actor, { folders: kids.folders, files: [] }, { archived: 'hide' })))
      }
      return sorted(out)
    },

    /**
     * What a listing shows beyond the item (keyed `type:id`): the owner's name
     * (null when the owner is no member — the agent, a removed person) and
     * whether it is shared with anyone besides its owner — told only to those
     * who manage the item (they could open its Share dialog anyway), else null.
     */
    async describeItems(actor: Actor, items: readonly ItemView[]): Promise<Record<string, ItemDescription>> {
      const people = new Map((await access.shareTargets()).people.map((p) => [p.id, p.name || p.email]))
      const out: Record<string, ItemDescription> = {}
      for (const item of items) {
        const loaded = await load(item.type, item.id)
        const source = loaded ? sourceRootOf(loaded, await chainFrom(parentOf(loaded))) : null
        const ownerName = source ? source.name : item.ownerId === MESSAGES_SYSTEM_OWNER ? 'Messages' : (people.get(item.ownerId) ?? null)
        const manages = loaded !== null && (await allows(actor, item.type, loaded, 'manage'))
        // A source root's company-wide view grant is how it is made, not sharing someone chose.
        const shared = manages
          ? (await access.listGrants(item.type, item.id)).some(
              (g) => !(g.subject.kind === 'user' && g.subject.userId === item.ownerId) && !(source?.id === item.id && g.subject.kind === 'company' && g.level === 'view'),
            )
          : null
        out[`${item.type}:${item.id}`] = { ownerName, shared, readOnlyFrom: source ? source.name : null }
      }
      return out
    },

    async search(actor: Actor, query: string): Promise<ItemView[]> {
      const q = query.trim()
      if (!q) return []
      // Archived items are still found, marked (inside an archived folder counts).
      const found = await visible(actor, await store.findByName(q), { archived: 'include' })
      const marked: ItemView[] = []
      for (const i of found) marked.push({ ...i, inArchive: i.archivedAt !== null || (await archivedAbove(actor, i.parentId)) !== null })
      return sorted(marked)
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
      const folder: DriveFolder = {
        id: randomUUID(),
        parentId,
        name,
        ownerId: ownerIdOf(actor),
        createdAt: at,
        updatedAt: at,
        trashedAt: null,
        archivedAt: null,
        archivedBy: null,
        source: null,
      }
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
        /** The archived folder this file sits in, if any (the file itself: `file.archivedAt`). */
        archivedIn: await archivedAbove(actor, file.folderId),
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

    /** Archives an item the actor can edit: it leaves the normal views and stays where it is. */
    async archive(actor: Actor, type: ItemType, id: string): Promise<ItemView> {
      await setArchived(actor, type, id, true)
      return view(type, id)
    },

    /** Back in the normal views; `stillIn` names an archived folder it is still inside. */
    async unarchive(actor: Actor, type: ItemType, id: string): Promise<{ item: ItemView; stillIn: Crumb | null }> {
      const item = await setArchived(actor, type, id, false)
      return { item: await view(type, id), stillIn: await archivedAbove(actor, parentOf(item)) }
    },

    /** Archives each item it can (one confirmation in the UI, one approval for the agent) and says why for the rest. */
    async archiveMany(actor: Actor, items: readonly ItemRef[]): Promise<{ archived: ItemView[]; errors: BatchError[] }> {
      const { done, errors } = await eachItem(items, async (r) => {
        await setArchived(actor, r.type, r.id, true)
        return view(r.type, r.id)
      })
      return { archived: done, errors }
    },

    async unarchiveMany(
      actor: Actor,
      items: readonly ItemRef[],
    ): Promise<{ unarchived: Array<{ item: ItemView; stillIn: Crumb | null }>; errors: BatchError[] }> {
      const { done, errors } = await eachItem(items, async (r) => {
        const item = await setArchived(actor, r.type, r.id, false)
        return { item: await view(r.type, r.id), stillIn: await archivedAbove(actor, parentOf(item)) }
      })
      return { unarchived: done, errors }
    },

    /**
     * The Archived view: every archived item the actor can open (not in the
     * trash), grouped by the folder it is in — the path as the actor sees it —
     * groups in path order, newest archived first within one.
     */
    async archived(actor: Actor): Promise<ArchiveGroup[]> {
      const people = new Map((await access.shareTargets()).people.map((p) => [p.id, p.name || p.email]))
      const all = await store.listArchived()
      const rows: Array<{ type: ItemType; item: DriveFolder | DriveFile; v: ItemView }> = [
        ...all.folders.map((f) => ({ type: 'folder' as const, item: f, v: folderView(f) })),
        ...all.files.map((f) => ({ type: 'file' as const, item: f, v: fileView(f) })),
      ]
      const groups = new Map<string, { group: ArchiveGroup; label: string }>()
      for (const { type, item, v } of rows) {
        const parentId = parentOf(item)
        if (item.trashedAt || (await inTrash(parentId)) || !(await allows(actor, type, item, 'view'))) continue
        const { root, path } = await pathFor(actor, (await chainFrom(parentId)).reverse(), item)
        const key = `${root.href}|${path.map((c) => c.id).join('/')}`
        let entry = groups.get(key)
        if (!entry) {
          const last = path[path.length - 1]
          entry = {
            group: { key, folder: last && last.id === parentId ? last : null, root, path, items: [] },
            label: [root.label, ...path.map((c) => c.name)].join(' / '),
          }
          groups.set(key, entry)
        }
        entry.group.items.push({
          ...v,
          canEdit: await allows(actor, type, item, 'edit'),
          canManage: await allows(actor, type, item, 'manage'),
          archivedByName: item.archivedBy ? (people.get(item.archivedBy) ?? null) : null,
        })
      }
      const newestFirst = (a: ItemView, b: ItemView) => (b.archivedAt?.getTime() ?? 0) - (a.archivedAt?.getTime() ?? 0)
      return [...groups.values()]
        .sort((a, b) => a.label.localeCompare(b.label))
        .map(({ group }) => ({ ...group, items: group.items.sort(newestFirst) }))
    },

    /**
     * Files "suggest what to archive" may put to the model, selected by plain
     * facts (never by meaning): ones the actor can edit, last changed before
     * the cut-off, not trashed or archived (nor inside an archived or trashed
     * folder), not a conversation's attachment nor a read-only source item; oldest first, at most
     * `limit` (`more` says there were others).
     */
    async archiveCandidates(actor: Actor, opts: { changedBefore: Date; limit: number }): Promise<{ candidates: ArchiveCandidate[]; more: boolean }> {
      const candidates: ArchiveCandidate[] = []
      for (const f of await store.filesChangedBefore(opts.changedBefore)) {
        if (f.ownerId === MESSAGES_SYSTEM_OWNER || f.source !== null) continue
        const chain = await chainFrom(f.folderId)
        if (chain.some((c) => c.trashedAt || c.archivedAt || c.ownerId === MESSAGES_SYSTEM_OWNER || c.source !== null)) continue
        if (!(await allows(actor, 'file', f, 'edit'))) continue
        if (candidates.length >= opts.limit) return { candidates, more: true }
        const { root, path } = await pathFor(actor, [...chain].reverse(), f)
        // At the top level "beside it" means the same person's own top-level files.
        const beside = (await store.children(f.folderId)).files.filter(
          (k) => !k.trashedAt && !k.archivedAt && (f.folderId !== null || k.ownerId === f.ownerId),
        )
        candidates.push({
          file: { ...fileView(f), canEdit: true, canManage: await allows(actor, 'file', f, 'manage') },
          createdAt: f.createdAt,
          root,
          path,
          folder: { files: beside.length, newestChange: new Date(Math.max(...beside.map((k) => k.updatedAt.getTime()))) },
        })
      }
      return { candidates, more: false }
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
