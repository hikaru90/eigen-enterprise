import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { MemberRole } from '$lib/server/auth/roles'
import { EeClient, PREVIEW_BUSY, SubstrateUnavailableError, type EeTransport, type PreviewView } from '$lib/server/ee/client'
import { AppBusyError, NO_EE_MESSAGE, previewIdFor } from './app-preview'
import { memoryEditLockStore } from './locks'
import { memoryDriveAccess } from './memory-access'
import { createDriveService, type Actor } from './service'
import { diskBlobStore } from './storage'
import { memoryDriveStore } from './store'
import { createDriveTools } from './tools'

const dirs: string[] = []
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
})

const text = (s: string) => new TextEncoder().encode(s)
const owner: Actor = { kind: 'user', userId: 'owner' }

/** A fake ee holding previews in memory, by the contract: one active at a time; it takes (copies, deletes) the tarball. */
function fakeEe() {
  const previews = new Map<string, PreviewView>()
  const calls: Array<{ method: string; path: string; body: unknown }> = []
  const taken: Array<{ tarball: string; bytes: Uint8Array; sha256: string }> = []
  const transport: EeTransport = async (method, path, body) => {
    calls.push({ method, path, body })
    if (method === 'GET' && path === '/v1/previews') return { status: 200, data: { previews: [...previews.values()] } }
    if (method === 'POST' && path === '/v1/previews') {
      const b = body as { id: string; tarball: string; sha256: string; folderName: string }
      const active = [...previews.values()].find((p) => p.id !== b.id && p.state !== 'stopped' && p.state !== 'failed')
      if (active) return { status: 409, data: { type: PREVIEW_BUSY, title: 'Busy', detail: 'another preview is running', running: active } }
      const bytes = new Uint8Array(await readFile(b.tarball))
      await rm(b.tarball)
      taken.push({ tarball: b.tarball, bytes, sha256: b.sha256 })
      const p: PreviewView = {
        id: b.id,
        folderName: b.folderName,
        state: 'installing',
        host: `${b.id}.preview.os.test`,
        url: `https://${b.id}.preview.os.test/`,
        script: null,
        startedAt: '2026-11-20T10:00:00.000Z',
        lastSeenAt: '2026-11-20T10:00:00.000Z',
        error: null,
        log: ['npm ci'],
      }
      previews.set(b.id, p)
      return { status: 202, data: { preview: p } }
    }
    const m = /^\/v1\/previews\/(pv[0-9a-f]{12})(\/seen)?$/.exec(path)
    const p = m ? previews.get(m[1]!) : undefined
    if (!p) return { status: 404, data: { type: 'urn:ee:not_found', detail: 'no such preview' } }
    if (method === 'GET') return { status: 200, data: { preview: p } }
    if (method === 'POST' && m![2]) return { status: 200, data: { preview: { ...p, lastSeenAt: '2026-11-20T10:05:00.000Z' } } }
    if (method === 'DELETE') {
      const stopped = { ...p, state: 'stopped' as const }
      previews.set(p.id, stopped)
      return { status: 200, data: { preview: stopped } }
    }
    return { status: 405, data: { detail: `${method} ${path}` } }
  }
  return { client: new EeClient(transport), previews, calls, taken }
}

async function setup(opts: { ee?: EeClient; env?: Record<string, string | undefined> } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'drive-apps-'))
  dirs.push(dir)
  const access = memoryDriveAccess({ users: { owner: { role: 'owner' }, admin: { role: 'admin' }, member: { role: 'member' } } })
  const drive = createDriveService({ store: memoryDriveStore(), blobs: diskBlobStore(join(dir, 'blobs')), access, maxUploadBytes: 1 << 20, locks: memoryEditLockStore() })
  const ee = fakeEe()
  const roles: Record<string, MemberRole> = { owner: 'owner', admin: 'admin', member: 'member' }
  const state = join(dir, 'state')
  const tools = createDriveTools({
    service: async () => drive,
    ee: opts.ee ?? ee.client,
    roleOf: async (id) => roles[id] ?? null,
    env: opts.env ?? { EE_STATE_DIR: state },
    now: () => new Date(1_763_632_800_000),
  })
  const tool = (n: string) => tools.find((t) => t.name === n)!
  // Every signed-in caller carries the admin kernel role (MCP); the company role decides.
  const human = (id: string) => ({ principal: { id, kind: 'human' as const, roles: ['admin'] }, requestId: 'r' })
  const agent = { principal: { id: 'agent:1', kind: 'agent' as const, roles: ['admin', 'agent'] }, requestId: 'r' }
  const shop = await drive.createFolder(owner, null, 'shop')
  await drive.upload(owner, shop.id, { name: 'package.json', bytes: text('{"scripts":{"dev":"vite"}}'), mime: null }, 'fail')
  await drive.upload(owner, shop.id, { name: 'package-lock.json', bytes: text('{}'), mime: null }, 'fail')
  const src = await drive.createFolder(owner, shop.id, 'src')
  await drive.upload(owner, src.id, { name: 'main.ts', bytes: text('export {}\n'), mime: null }, 'fail')
  const nm = await drive.createFolder(owner, shop.id, 'node_modules')
  await drive.upload(owner, nm.id, { name: 'vite.js', bytes: text('x'), mime: null }, 'fail')
  return { dir, state, drive, ee, tool, human, agent, shop }
}

describe('drive.app_* tools (plan/phase-drive-app-preview.md)', () => {
  it('the preview id is pv + the first 12 hex of sha256(folder id)', () => {
    const id = previewIdFor('folder-1')
    expect(id).toMatch(/^pv[0-9a-f]{12}$/)
    expect(id).toBe(`pv${createHash('sha256').update('folder-1').digest('hex').slice(0, 12)}`)
  })

  it('declares status as a read for anyone who can view, run and stop as admin-role writes', async () => {
    const { tool } = await setup()
    expect(tool('drive.app_status')).toMatchObject({ auditClass: 'read', permission: { roles: ['admin', 'agent', 'member'] } })
    for (const n of ['drive.app_run', 'drive.app_stop']) {
      expect(tool(n)).toMatchObject({ auditClass: 'mutate', permission: { roles: ['admin'] } })
      expect(tool(n).approvalRisk).toBeUndefined()
    }
    expect(tool('drive.app_run').activity!({ folder_id: 'f' }, { preview: { folderName: 'shop' } })).toBe('Started the app in the Drive folder “shop”')
    expect(tool('drive.app_stop').activity!({ preview_id: 'pv000000000000' }, undefined)).toBe('Tried to stop the app preview pv000000000000')
  })

  it('an admin runs a folder: its snapshot (no node_modules) goes to ee under $EE_STATE_DIR/previews with its sha256', async () => {
    const { tool, human, ee, state, shop, dir } = await setup()
    const out = (await tool('drive.app_run').handler(human('admin'), { folder_id: shop.id })) as { preview: PreviewView }
    const id = previewIdFor(shop.id)
    expect(out.preview).toMatchObject({ id, folderName: 'shop', state: 'installing' })
    const post = ee.calls.find((c) => c.method === 'POST' && c.path === '/v1/previews')!
    expect(post.body).toEqual({ id, tarball: join(state, 'previews', `${id}-1763632800000.tar.gz`), sha256: expect.stringMatching(/^[0-9a-f]{64}$/), folderName: 'shop', author: 'human:admin' })
    const [got] = ee.taken
    expect(createHash('sha256').update(got!.bytes).digest('hex')).toBe(got!.sha256)
    const out2 = join(dir, 'x')
    await mkdir(out2)
    const tgz = join(dir, 'got.tar.gz')
    await writeFile(tgz, got!.bytes)
    execFileSync('tar', ['-xzf', tgz, '-C', out2])
    expect((await readdir(out2)).sort()).toEqual(['package-lock.json', 'package.json', 'src'])
    expect(await readFile(join(out2, 'src', 'main.ts'), 'utf8')).toBe('export {}\n')
  })

  it('status: webApp facts, the preview marked seen; unknown to ee → preview null without a seen call', async () => {
    const { drive, tool, human, ee, shop } = await setup()
    // A member the folder is shared with sees its status too.
    await drive.setGrants(owner, 'folder', shop.id, [{ subject: { kind: 'user', userId: 'member' }, level: 'view' }])
    const before = await tool('drive.app_status').handler(human('member'), { folder_id: shop.id })
    expect(before).toEqual({ folder: { id: shop.id, name: 'shop' }, webApp: { script: 'dev', lockfile: 'package-lock.json' }, previewId: previewIdFor(shop.id), managed: true, reason: null, preview: null })
    expect(ee.calls.some((c) => c.path.endsWith('/seen'))).toBe(false)
    await tool('drive.app_run').handler(human('owner'), { folder_id: shop.id })
    const after = (await tool('drive.app_status').handler(human('owner'), { folder_id: shop.id })) as { preview: PreviewView }
    expect(after.preview).toMatchObject({ state: 'installing', lastSeenAt: '2026-11-20T10:05:00.000Z' })
    expect(ee.calls.at(-1)).toMatchObject({ method: 'POST', path: `/v1/previews/${previewIdFor(shop.id)}/seen` })
  })

  it('status needs view on the folder (the agent may read it, to help fix a failing start)', async () => {
    const { drive, tool, human, agent } = await setup()
    const mine = await drive.createFolder({ kind: 'user', userId: 'member' }, null, 'private')
    await expect(tool('drive.app_status').handler(human('nobody'), { folder_id: mine.id })).rejects.toMatchObject({ code: 'not_found' })
    expect(await tool('drive.app_status').handler(agent, { folder_id: mine.id })).toMatchObject({ webApp: null, preview: null })
  })

  it('the agent is refused Run and Stop outright (D11), and so is a member; ee is never asked', async () => {
    const { tool, human, agent, ee, shop } = await setup()
    for (const n of ['drive.app_run', 'drive.app_stop']) {
      await expect(tool(n).handler(agent, { folder_id: shop.id })).rejects.toMatchObject({ code: 'permission_denied', message: expect.stringMatching(/only a human/) })
      await expect(tool(n).handler(human('member'), { folder_id: shop.id })).rejects.toMatchObject({ code: 'permission_denied', message: 'Only an owner or admin can run or stop apps in Drive.' })
    }
    expect(ee.calls).toEqual([])
  })

  it('another active preview: busy with the running one; the kernel copy of the tarball is removed', async () => {
    const { drive, tool, human, state, shop } = await setup()
    await tool('drive.app_run').handler(human('owner'), { folder_id: shop.id })
    const blog = await drive.createFolder(owner, null, 'blog')
    await drive.upload(owner, blog.id, { name: 'package.json', bytes: text('{"scripts":{"start":"node ."}}'), mime: null }, 'fail')
    const err = await tool('drive.app_run').handler(human('owner'), { folder_id: blog.id }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(AppBusyError)
    expect(err).toMatchObject({ code: 'busy', message: 'Another app is running: shop', running: { id: previewIdFor(shop.id), folderName: 'shop' } })
    expect(await readdir(join(state, 'previews'))).toEqual([])
    // Stopping it by its preview id (the busy message's button), then the other one runs.
    expect(await tool('drive.app_stop').handler(human('owner'), { preview_id: previewIdFor(shop.id) })).toMatchObject({ preview: { state: 'stopped' } })
    expect(await tool('drive.app_run').handler(human('owner'), { folder_id: blog.id })).toMatchObject({ preview: { folderName: 'blog' } })
  })

  it('stop by folder; a preview ee does not know is not found', async () => {
    const { tool, human, shop } = await setup()
    await expect(tool('drive.app_stop').handler(human('admin'), { folder_id: shop.id })).rejects.toMatchObject({ code: 'not_found', message: 'No app is running for this folder.' })
    await tool('drive.app_run').handler(human('admin'), { folder_id: shop.id })
    expect(await tool('drive.app_stop').handler(human('admin'), { folder_id: shop.id })).toMatchObject({ preview: { state: 'stopped' } })
    await expect(tool('drive.app_stop').handler(human('admin'), { preview_id: '../etc' })).rejects.toThrow()
    await expect(tool('drive.app_stop').handler(human('admin'), { folder_id: shop.id, preview_id: previewIdFor(shop.id) })).rejects.toThrow()
  })

  it('without ee: Run fails loud with the plain sentence before any snapshot; status says managed false', async () => {
    const down = new EeClient(async () => {
      throw new SubstrateUnavailableError('ENOENT')
    })
    const { tool, human, shop, state } = await setup({ ee: down })
    await expect(tool('drive.app_run').handler(human('owner'), { folder_id: shop.id })).rejects.toMatchObject({ code: 'unavailable', message: NO_EE_MESSAGE })
    await expect(readdir(join(state, 'previews'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await tool('drive.app_status').handler(human('owner'), { folder_id: shop.id })).toMatchObject({ managed: false, reason: NO_EE_MESSAGE, preview: null, webApp: { script: 'dev' } })
  })

  it('EE_STATE_DIR unset: Run refuses (no default place for the snapshot)', async () => {
    const { tool, human, shop, ee } = await setup({ env: {} })
    await expect(tool('drive.app_run').handler(human('owner'), { folder_id: shop.id })).rejects.toThrow(/EE_STATE_DIR is not set/)
    expect(ee.calls).toEqual([])
  })

  it('a folder without a dev or start script has nothing to run', async () => {
    const { drive, tool, human } = await setup()
    const docs = await drive.createFolder(owner, null, 'docs')
    await expect(tool('drive.app_run').handler(human('owner'), { folder_id: docs.id })).rejects.toMatchObject({ code: 'invalid', message: expect.stringMatching(/no package.json with a dev or start script/) })
  })
})
