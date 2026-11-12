import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { memoryEditLockStore } from './locks'
import { memoryDriveAccess } from './memory-access'
import { createDriveService, MESSAGES_SYSTEM_OWNER, type Actor } from './service'
import { diskBlobStore } from './storage'
import { memoryDriveStore } from './store'

/** What the full-width Drive browser shows beyond a listing: owner names, sharing badges, Messages. */

const dirs: string[] = []
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
})

const owner: Actor = { kind: 'user', userId: 'owner' }
const alice: Actor = { kind: 'user', userId: 'alice' }
const bob: Actor = { kind: 'user', userId: 'bob' }
const carol: Actor = { kind: 'user', userId: 'carol' }
const agent: Actor = { kind: 'agent', id: 'agent:1' }
const messages: Actor = { kind: 'agent', id: MESSAGES_SYSTEM_OWNER }

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'drive-browser-'))
  dirs.push(dir)
  const access = memoryDriveAccess({
    users: {
      owner: { role: 'owner', name: 'Olivia Owner' },
      alice: { role: 'member', name: 'Alice Archer' },
      bob: { role: 'member', name: 'Bob Baker', groups: ['design'] },
      carol: { role: 'member', name: 'Carol Cole' },
    },
    groups: { design: 'Design' },
  })
  return createDriveService({
    store: memoryDriveStore(),
    blobs: diskBlobStore(dir),
    access,
    maxUploadBytes: 1024,
    locks: memoryEditLockStore(),
  })
}

describe('drive.describeItems', () => {
  it('names every owner; "shared" only on items the viewer manages (their own grant does not count)', async () => {
    const drive = await setup()
    const projects = await drive.createFolder(alice, null, 'Projects')
    const notes = await drive.createDocument(alice, projects.id, 'md', 'notes')
    const plan = await drive.createDocument(alice, projects.id, 'md', 'plan')
    await drive.setGrants(alice, 'file', notes.id, [
      { subject: { kind: 'user', userId: 'alice' }, level: 'manage' },
      { subject: { kind: 'user', userId: 'bob' }, level: 'view' },
    ])
    await drive.setGrants(alice, 'folder', projects.id, [
      { subject: { kind: 'user', userId: 'alice' }, level: 'manage' },
      { subject: { kind: 'group', groupId: 'design' }, level: 'view' },
    ])

    const inside = await drive.describeItems(
      alice,
      (await drive.listFolder(alice, projects.id)).items,
    )
    expect(inside[`file:${notes.id}`]).toEqual({ ownerName: 'Alice Archer', shared: true, readOnlyFrom: null })
    expect(inside[`file:${plan.id}`]).toEqual({ ownerName: 'Alice Archer', shared: false, readOnlyFrom: null })
    const top = await drive.describeItems(alice, (await drive.listFolder(alice, null)).items)
    expect(top[`folder:${projects.id}`]).toEqual({ ownerName: 'Alice Archer', shared: true, readOnlyFrom: null })

    // Bob (view) sees whose it is, not who else it is shared with.
    const forBob = await drive.describeItems(bob, (await drive.listFolder(bob, projects.id)).items)
    expect(forBob[`file:${notes.id}`]).toEqual({ ownerName: 'Alice Archer', shared: null, readOnlyFrom: null })
  })

  it('names the Messages owner and leaves an owner who is not a member unnamed', async () => {
    const drive = await setup()
    const root = await drive.createFolder(messages, null, 'Messages')
    const byAgent = await drive.createFolder(agent, null, 'Agent notes')
    const described = await drive.describeItems(owner, [root, byAgent])
    expect(described[`folder:${root.id}`]?.ownerName).toBe('Messages')
    expect(described[`folder:${byAgent.id}`]?.ownerName).toBeNull()
  })
})

describe('drive.messagesFolders', () => {
  it('lists the conversation attachment folders the person can open', async () => {
    const drive = await setup()
    const root = await drive.createFolder(messages, null, 'Messages')
    const general = await drive.createFolder(messages, root.id, '#general')
    const board = await drive.createFolder(messages, root.id, '#board')
    await drive.setGrants(owner, 'folder', general.id, [
      { subject: { kind: 'company' }, level: 'edit' },
    ])
    await drive.setGrants(owner, 'folder', board.id, [
      { subject: { kind: 'user', userId: 'carol' }, level: 'edit' },
    ])
    await drive.createFolder(alice, null, 'Not a conversation')

    expect((await drive.messagesFolders(bob)).map((i) => i.name)).toEqual(['#general'])
    expect((await drive.messagesFolders(carol)).map((i) => i.name)).toEqual(['#board', '#general'])
    expect((await drive.messagesFolders(owner)).map((i) => i.name)).toEqual(['#board', '#general'])
  })

  it('is empty before Messages kept any attachment', async () => {
    const drive = await setup()
    expect(await drive.messagesFolders(alice)).toEqual([])
  })
})
