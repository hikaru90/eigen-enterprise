import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { LOCK_TTL_MS, memoryEditLockStore } from './locks'
import { memoryDriveAccess } from './memory-access'
import { createDriveService, type Actor } from './service'
import { diskBlobStore } from './storage'
import { memoryDriveStore } from './store'

/** Edit locks (W-6): one editor session per file, heartbeat, stale release, takeover, and writes that respect it. */

const dirs: string[] = []
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
})

const ada: Actor = { kind: 'user', userId: 'ada' }
const ben: Actor = { kind: 'user', userId: 'ben' }
const viewer: Actor = { kind: 'user', userId: 'vic' }
const agent: Actor = { kind: 'agent', id: 'agent:1' }

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'drive-lock-'))
  dirs.push(dir)
  const access = memoryDriveAccess({
    users: { ada: { role: 'member', name: 'Ada Owner' }, ben: { role: 'member', name: 'Ben Member' }, vic: { role: 'member', name: 'Vic Viewer' } },
    groups: {},
  })
  let t = Date.parse('2026-11-03T10:00:00Z')
  const drive = createDriveService({ store: memoryDriveStore(), blobs: diskBlobStore(dir), access, maxUploadBytes: 1 << 20, locks: memoryEditLockStore(), now: () => new Date(t) })
  const doc = await drive.createDocument(ada, null, 'md', 'notes')
  await drive.setGrants(ada, 'file', doc.id, [
    { subject: { kind: 'user', userId: 'ada' }, level: 'manage' },
    { subject: { kind: 'user', userId: 'ben' }, level: 'edit' },
    { subject: { kind: 'user', userId: 'vic' }, level: 'view' },
  ])
  return { drive, id: doc.id, advance: (ms: number) => (t += ms) }
}

describe('drive edit locks', () => {
  it('the first editor holds the lock; a second sees who is editing', async () => {
    const { drive, id } = await setup()
    expect(await drive.acquireLock(ada, id, 'tab-a')).toMatchObject({ state: 'held' })
    const b = await drive.acquireLock(ben, id, 'tab-b')
    expect(b).toMatchObject({ state: 'locked', holder: { userId: 'ada', name: 'Ada Owner', sessionId: 'tab-a' } })
    expect(await drive.lockStatus(viewer, id)).toMatchObject({ state: 'locked', holder: { name: 'Ada Owner' } })
  })

  it('re-acquiring from the same session keeps the lock and its start time', async () => {
    const { drive, id, advance } = await setup()
    const first = await drive.acquireLock(ada, id, 'tab-a')
    advance(5000)
    const again = await drive.acquireLock(ada, id, 'tab-a')
    expect(again).toEqual(first)
  })

  it('a second tab of the same person is a second editor', async () => {
    const { drive, id } = await setup()
    await drive.acquireLock(ada, id, 'tab-a')
    expect(await drive.acquireLock(ada, id, 'tab-a2')).toMatchObject({ state: 'locked', holder: { userId: 'ada' } })
  })

  it('heartbeats keep the lock; silence past the TTL frees it', async () => {
    const { drive, id, advance } = await setup()
    await drive.acquireLock(ada, id, 'tab-a')
    advance(LOCK_TTL_MS - 1000)
    expect(await drive.heartbeatLock(ada, id, 'tab-a')).toMatchObject({ state: 'held' })
    advance(LOCK_TTL_MS - 1000)
    expect(await drive.acquireLock(ben, id, 'tab-b')).toMatchObject({ state: 'locked' })
    advance(2000)
    expect(await drive.lockStatus(viewer, id)).toEqual({ state: 'free' })
    expect(await drive.acquireLock(ben, id, 'tab-b')).toMatchObject({ state: 'held' })
  })

  it('takeover moves the lock; the previous holder learns it on the next heartbeat', async () => {
    const { drive, id } = await setup()
    await drive.acquireLock(ada, id, 'tab-a')
    expect(await drive.acquireLock(ben, id, 'tab-b', { takeover: true })).toMatchObject({ state: 'held' })
    expect(await drive.heartbeatLock(ada, id, 'tab-a')).toMatchObject({ state: 'locked', holder: { userId: 'ben', name: 'Ben Member' } })
  })

  it('a taken-over session cannot save; the holder can', async () => {
    const { drive, id } = await setup()
    await drive.acquireLock(ada, id, 'tab-a')
    await drive.writeText(ada, id, '# A\n', 'tab-a')
    await drive.acquireLock(ben, id, 'tab-b', { takeover: true })
    await expect(drive.writeText(ada, id, '# A late\n', 'tab-a')).rejects.toMatchObject({ code: 'locked', holder: { userId: 'ben' } })
    await drive.writeText(ben, id, '# B\n', 'tab-b')
    expect((await drive.readText(ada, id)).content).toBe('# B\n')
  })

  it('writes without a session (the agent, scripts) wait while someone edits', async () => {
    const { drive, id, advance } = await setup()
    await drive.writeText(ada, id, 'v0\n')
    await drive.acquireLock(ada, id, 'tab-a')
    await expect(drive.writeText(agent, id, 'x')).rejects.toMatchObject({ code: 'locked', message: /Ada Owner is editing/ })
    await expect(drive.restoreRevision(agent, id, (await drive.listRevisions(ada, id))[0]!.id)).rejects.toMatchObject({ code: 'locked' })
    advance(LOCK_TTL_MS + 1)
    await expect(drive.writeText(agent, id, 'x')).resolves.toBeTruthy()
  })

  it('a session whose lock went stale and stayed free reclaims it on save', async () => {
    const { drive, id, advance } = await setup()
    await drive.acquireLock(ada, id, 'tab-a')
    await drive.releaseLock(ada, id, 'tab-a')
    advance(LOCK_TTL_MS * 2)
    await drive.writeText(ada, id, 'saved\n', 'tab-a')
    expect(await drive.acquireLock(ben, id, 'tab-b')).toMatchObject({ state: 'locked', holder: { userId: 'ada' } })
  })

  it('release frees the lock only for the holding session', async () => {
    const { drive, id } = await setup()
    await drive.acquireLock(ada, id, 'tab-a')
    await drive.releaseLock(ben, id, 'tab-b')
    expect(await drive.lockStatus(ada, id)).toMatchObject({ state: 'locked' })
    await drive.releaseLock(ada, id, 'tab-a')
    expect(await drive.lockStatus(ada, id)).toEqual({ state: 'free' })
  })

  it('view-only people cannot take the lock (or take over)', async () => {
    const { drive, id } = await setup()
    await expect(drive.acquireLock(viewer, id, 'tab-v')).rejects.toMatchObject({ code: 'forbidden' })
    await expect(drive.acquireLock(viewer, id, 'tab-v', { takeover: true })).rejects.toMatchObject({ code: 'forbidden' })
  })

  it('only Markdown/CSV files are locked for editing', async () => {
    const { drive } = await setup()
    const pdf = await drive.upload(ada, null, { name: 'a.pdf', bytes: new TextEncoder().encode('%PDF'), mime: 'application/pdf' })
    await expect(drive.acquireLock(ada, pdf.id, 'tab-a')).rejects.toMatchObject({ code: 'invalid' })
  })

  it('reads one revision’s text; restore with the lock is a new revision', async () => {
    const { drive, id, advance } = await setup()
    await drive.writeText(ada, id, 'v1\n')
    advance(1000)
    await drive.acquireLock(ada, id, 'tab-a')
    await drive.writeText(ada, id, 'v2\n', 'tab-a')
    const revs = await drive.listRevisions(ada, id)
    const texts = await Promise.all(revs.map(async (r) => ({ r, content: (await drive.readRevision(viewer, id, r.id)).content })))
    const v1 = texts.find((x) => x.content === 'v1\n')!.r
    await drive.restoreRevision(ada, id, v1.id, 'tab-a')
    expect((await drive.readText(ada, id)).content).toBe('v1\n')
    expect(await drive.listRevisions(ada, id)).toHaveLength(revs.length + 1)
  })
})
