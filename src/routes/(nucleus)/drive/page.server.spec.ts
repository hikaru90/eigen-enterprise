import type { DriveService } from '../../../../modules/drive/service'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { drivePage, requestActor } from '../../../../modules/drive/http'
import { memoryEditLockStore } from '../../../../modules/drive/locks'
import { memoryDriveAccess } from '../../../../modules/drive/memory-access'
import {
  createDriveService,
  MESSAGES_SYSTEM_OWNER,
  type Actor,
} from '../../../../modules/drive/service'
import { createDriveSourceWriter } from '../../../../modules/drive/source-writer'
import { diskBlobStore } from '../../../../modules/drive/storage'
import { memoryDriveStore } from '../../../../modules/drive/store'

const { holder } = vi.hoisted(() => ({
  holder: { service: null as DriveService | null },
}))

vi.mock('$lib/server/drive', () => ({
  driveService: async () => holder.service!,
  drivePage,
  requestActor,
}))

const { load } = await import('./+page.server')

const dirs: string[] = []
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
})

describe('/drive +page.server load (overview)', () => {
  let drive: DriveService
  const owner: Actor = { kind: 'user', userId: 'owner' }
  const alice: Actor = { kind: 'user', userId: 'alice' }
  const bob: Actor = { kind: 'user', userId: 'bob' }
  const messagesActor: Actor = { kind: 'agent', id: MESSAGES_SYSTEM_OWNER }

  beforeEach(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'drive-overview-page-'))
    dirs.push(dir)
    const store = memoryDriveStore()
    const blobs = diskBlobStore(dir)
    const access = memoryDriveAccess({
      users: {
        owner: { role: 'owner', name: 'Olivia Owner' },
        alice: { role: 'member', name: 'Alice Archer' },
        bob: { role: 'member', name: 'Bob Baker' },
      },
    })
    drive = createDriveService({
      store,
      blobs,
      access,
      maxUploadBytes: 1024,
      locks: memoryEditLockStore(),
    })
    holder.service = drive
    const writer = createDriveSourceWriter({ store, blobs, access })

    await drive.createFolder(alice, null, 'My Projects')
    const shared = await drive.createFolder(bob, null, 'Team Plan')
    await drive.setGrants(bob, 'folder', shared.id, [
      { subject: { kind: 'user', userId: 'bob' }, level: 'manage' },
      { subject: { kind: 'user', userId: 'alice' }, level: 'view' },
    ])
    const msgRoot = await drive.createFolder(messagesActor, null, 'Messages')
    const general = await drive.createFolder(messagesActor, msgRoot.id, '#general')
    await drive.setGrants(owner, 'folder', general.id, [
      { subject: { kind: 'company' }, level: 'edit' },
    ])
    await writer.ensureRoot('repos', 'GitHub')
  })

  it('loads unified overview items across mine, shared, messages and sources with descriptions', async () => {
    const data = (await load({
      locals: { user: { id: 'alice' } },
      url: new URL('http://x/drive'),
    } as never)) as {
      items: Array<{ type: string; id: string; name: string; origin: string; originLabel: string }>
      canEdit: boolean
      root: { label: string; href: string }
      origin: string | null
      query: string
      results: unknown
      describe: Record<string, { ownerName: string | null; readOnlyFrom: string | null }>
    }

    expect(data.canEdit).toBe(true)
    expect(data.root).toEqual({ label: 'Overview', href: '/drive' })
    expect(data.origin).toBeNull()
    expect(data.query).toBe('')
    expect(data.results).toBeNull()
    expect(data.items.map((i) => [i.name, i.origin, i.originLabel])).toHaveLength(4)
    expect(data.items.map((i) => [i.name, i.origin, i.originLabel])).toEqual(
      expect.arrayContaining([
        ['#general', 'messages', 'Messages'],
        ['GitHub', 'source', 'GitHub'],
        ['My Projects', 'mine', 'My drive'],
        ['Team Plan', 'shared', 'Shared with me'],
      ]),
    )
    for (const item of data.items) {
      expect(data.describe[`${item.type}:${item.id}`]).toBeDefined()
    }
  })

  it('passes ?origin=mine through while loading full overview items for instant pill switching', async () => {
    const data = (await load({
      locals: { user: { id: 'alice' } },
      url: new URL('http://x/drive?origin=mine'),
    } as never)) as {
      items: Array<{ origin: string }>
      origin: string | null
    }

    expect(data.origin).toBe('mine')
    expect(data.items.map((i) => i.origin).sort()).toEqual(['messages', 'mine', 'shared', 'source'])
  })

  it('runs search when ?q= is present and describes the search results', async () => {
    const data = (await load({
      locals: { user: { id: 'alice' } },
      url: new URL('http://x/drive?q=plan'),
    } as never)) as {
      query: string
      results: Array<{ type: string; id: string; name: string }> | null
      describe: Record<string, unknown>
    }

    expect(data.query).toBe('plan')
    expect(data.results?.map((r) => r.name)).toEqual(['Team Plan'])
    const hit = data.results![0]!
    expect(data.describe[`${hit.type}:${hit.id}`]).toBeDefined()
  })
})
