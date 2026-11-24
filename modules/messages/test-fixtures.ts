import type { AttachmentPort, DriveFileInfo, MessagesDeps } from './service'
import { coworkerEmail } from '$lib/server/coworkers/service'
import { FakeAccessPort, levelSatisfies, type AccessLevel, type GrantInput } from './access-port'
import { MemoryDirectory, MemoryMessagesStore } from './memory-store'
import type { CoworkerPresencePort } from './presence'

/** Owner + two members, a fake access port and a ticking clock. */
export function fixture() {
  const store = new MemoryMessagesStore()
  const access = new FakeAccessPort()
  const directory = new MemoryDirectory([
    { id: 'owner', name: 'Olga Owner', email: 'olga@co.test', kind: 'human' },
    { id: 'bea', name: 'Bea Member', email: 'bea@co.test', kind: 'human' },
    { id: 'carl', name: 'Carl Member', email: 'carl@co.test', kind: 'human' },
  ])
  for (const [id, role] of [
    ['owner', 'owner'],
    ['bea', 'member'],
    ['carl', 'member'],
  ] as const) {
    directory.roles.set(id, role)
    access.roles.set(id, role)
  }
  let t = Date.UTC(2026, 10, 3, 9, 0, 0)
  let n = 0
  const deps: MessagesDeps = {
    store,
    access,
    directory,
    now: () => new Date((t += 1000)),
    newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
  }
  return { store, access, directory, deps }
}

/**
 * Adds an AI co-worker to a fixture: a member (role member, kind coworker) whose
 * address is the one the coworkers service builds, so its @handle is `slug`.
 */
export function addCoworker(f: ReturnType<typeof fixture>, c: { id: string; slug: string; name: string }): void {
  f.directory.people.push({ id: c.id, name: c.name, email: coworkerEmail(c.slug, c.id), kind: 'coworker' })
  f.directory.roles.set(c.id, 'member')
  f.access.roles.set(c.id, 'member')
}

type FakeFolder ={ id: string; parentId: string | null; name: string; grants: GrantInput[] | null }

/**
 * In-memory Drive behind AttachmentPort with the contract's semantics that
 * matter here: owner/admin see everything; others need a grant on the folder
 * (user, group or company); uploads need edit; files over `maxBytes` are refused.
 */
export class FakeDrive implements AttachmentPort {
  folders: FakeFolder[] = []
  files: DriveFileInfo[] = []
  /** Each uploaded file's bytes, by file id. */
  bytes = new Map<string, Uint8Array>()
  private n = 0
  constructor(
    private readonly access: FakeAccessPort,
    readonly maxBytes = 1000,
  ) {}

  private allowed(userId: string, folderId: string | null, level: AccessLevel): boolean {
    const role = this.access.roles.get(userId)
    if (!role) return false
    if (role === 'owner' || role === 'admin') return true
    const f = this.folders.find((x) => x.id === folderId)
    return (f?.grants ?? []).some((g) => {
      const s = g.subject
      const applies =
        s.kind === 'company' ||
        (s.kind === 'user' && s.userId === userId) ||
        (s.kind === 'group' && this.access.groups.some((gr) => gr.id === s.groupId && gr.memberIds.includes(userId)))
      return applies && levelSatisfies(g.level, level)
    })
  }

  async createSystemFolder(parentId: string | null, name: string) {
    const id = `folder-${++this.n}`
    this.folders.push({ id, parentId, name, grants: null })
    return id
  }
  async initFolderGrants(_creatorId: string, folderId: string, grants: GrantInput[]) {
    const f = this.folders.find((x) => x.id === folderId)
    if (!f) throw new Error('no such folder')
    if (f.grants) throw new Error('already has grants')
    f.grants = grants
  }
  async upload(actorId: string, folderId: string, file: { name: string; bytes: Uint8Array; mime: string | null }) {
    if (!this.allowed(actorId, folderId, 'edit')) throw new Error('forbidden')
    if (file.bytes.byteLength > this.maxBytes) {
      return { ok: false as const, error: `“${file.name}” is too large; files can be at most ${this.maxBytes} B.` }
    }
    const info: DriveFileInfo = {
      id: `file-${++this.n}`,
      name: file.name,
      mime: file.mime ?? 'application/octet-stream',
      size: file.bytes.byteLength,
      folderId,
      ownerId: actorId,
    }
    this.files.push(info)
    this.bytes.set(info.id, file.bytes.slice())
    return { ok: true as const, file: info }
  }
  async fileInfo(actorId: string, fileId: string) {
    const f = this.files.find((x) => x.id === fileId)
    return f && this.allowed(actorId, f.folderId, 'view') ? f : null
  }
  async read(actorId: string, fileId: string) {
    const f = await this.fileInfo(actorId, fileId)
    const bytes = f ? this.bytes.get(f.id) : undefined
    return f && bytes ? { mime: f.mime, bytes } : null
  }
}

/** fixture() plus the fake Drive and a recording audit sink. */
export function depthFixture() {
  const f = fixture()
  const drive = new FakeDrive(f.access)
  const audits: Array<{ type: string; principalId: string; payload: Record<string, unknown> }> = []
  f.deps.drive = drive
  f.deps.audit = async (e) => {
    audits.push(e)
  }
  return { ...f, drive, audits }
}

/** A company whose co-workers have no status yet (each shows as paused). */
export const NO_COWORKERS: CoworkerPresencePort = { statuses: async () => new Map(), subscribe: () => () => {} }
