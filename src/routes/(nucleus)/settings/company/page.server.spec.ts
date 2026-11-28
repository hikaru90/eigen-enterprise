import sharp from 'sharp'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { memoryCompanyProfileStore } from '$lib/server/company/store'
import { sha256Hex, type BlobStore } from '../../../../../modules/drive/storage'

const { roleMock, storage } = vi.hoisted(() => ({
  roleMock: vi.fn(async (_id: string): Promise<string | null> => 'admin'),
  storage: { store: null as unknown, blobs: null as unknown, share: null as unknown, traces: null as unknown },
}))
vi.mock('../../../../../modules/contribute/share/live', () => ({
  shareDeps: async () => storage.share,
}))
vi.mock('$lib/server/traces/live', () => ({ liveTracesDeps: async () => storage.traces }))
vi.mock('$lib/server/auth/user-role', () => ({ getUserRole: roleMock }))
vi.mock('$lib/server/company/live', () => ({ companyStorage: () => storage }))
vi.mock('$lib/server/company/store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/server/company/store')>()),
  companyProfileStore: () => storage.store,
}))
vi.mock('$lib/server/overview/sources', async () => {
  const { resolveCompanyIdentity } = await import('$lib/server/company/service')
  return {
    companyIdentity: () =>
      resolveCompanyIdentity({
        store: storage.store as never,
        interviewName: async () => 'Founding Name',
      }),
  }
})

import type { ShareDeps } from '../../../../../modules/contribute/share/service'
import { HUB_NOT_CONFIGURED } from '../../../../../modules/contribute/share/hub'
import { memoryInstallKeyStore } from '../../../../../modules/contribute/share/identity'
import { fixture } from '../../../../../modules/contribute/test-fixtures'
import { memoryTraceStore } from '../../../../../modules/traces/memory-store'
import { actions, load } from './+page.server'

function shareFixture() {
  const f = fixture()
  const deps: ShareDeps = {
    share: f.share,
    contributions: f.store,
    keys: memoryInstallKeyStore(),
    hub: () => ({ ok: false, reason: 'not_configured', message: HUB_NOT_CONFIGURED }),
    transport: () => async () => {
      throw new Error('no hub in this spec')
    },
    scrub: async () => {
      throw new Error('no scrub in this spec')
    },
    appVersion: '0.5.9',
    now: f.now,
    providerReady: async () => true,
  }
  return { f, deps }
}

const sharingForm = (enabled: string, withdraw = false) => {
  const f = new FormData()
  f.set('enabled', enabled)
  if (withdraw) f.set('withdraw', 'on')
  return f
}

function memoryBlobs(): BlobStore & { shas: () => string[] } {
  const blobs = new Map<string, Uint8Array>()
  return {
    async put(bytes) {
      const sha256 = sha256Hex(bytes)
      blobs.set(sha256, bytes)
      return { sha256, size: bytes.byteLength, created: true }
    },
    get: async (sha) => blobs.get(sha)!,
    has: async (sha) => blobs.has(sha),
    remove: async (sha) => void blobs.delete(sha),
    shas: () => [...blobs.keys()],
  }
}

const png = async () =>
  new Uint8Array(
    await sharp({ create: { width: 48, height: 48, channels: 3, background: '#123' } })
      .png()
      .toBuffer(),
  )

function ev(form?: FormData, user: { id: string } | null = { id: 'u-admin' }) {
  return {
    locals: { user },
    request: new Request('http://x/settings/company', {
      method: 'POST',
      body: form ?? new FormData(),
    }),
  } as never
}

const nameForm = (name: string) => {
  const f = new FormData()
  f.set('name', name)
  return f
}
const logoForm = (
  bytes: Uint8Array,
  type: string,
  name = 'logo.png',
  crop?: { left: number; top: number; size: number },
) => {
  const f = new FormData()
  f.set('logo', new File([bytes as BlobPart], name, { type }))
  if (crop) f.set('crop', JSON.stringify(crop))
  return f
}

describe('Settings → Company (owner and admins)', () => {
  beforeEach(() => {
    roleMock.mockResolvedValue('admin')
    storage.store = memoryCompanyProfileStore()
    storage.blobs = memoryBlobs()
    storage.share = shareFixture().deps
    storage.traces = {
      store: memoryTraceStore(),
      hub: { config: () => ({ ok: false, message: HUB_NOT_CONFIGURED }), ready: async () => ({ ok: true }), send: async () => ({ status: 200, text: '' }), unauthorized: async () => {} },
      now: () => new Date('2026-11-21T00:00:00Z'),
    }
  })

  it.each(['member', null])(
    'a %s gets 403 — the page and every action, changing nothing',
    async (role) => {
      roleMock.mockResolvedValue(role)
      await expect(load(ev() as never)).rejects.toMatchObject({ status: 403 })
      await expect(actions.saveName!(ev(nameForm('Hijack')))).rejects.toMatchObject({ status: 403 })
      await expect(
        actions.uploadLogo!(ev(logoForm(await png(), 'image/png'))),
      ).rejects.toMatchObject({ status: 403 })
      await expect(actions.recropLogo!(ev())).rejects.toMatchObject({ status: 403 })
      await expect(actions.removeLogo!(ev())).rejects.toMatchObject({ status: 403 })
      expect(await (storage.store as ReturnType<typeof memoryCompanyProfileStore>).get()).toBeNull()
    },
  )

  it('sends signed-out visitors to sign in', async () => {
    await expect(load(ev(undefined, null) as never)).rejects.toMatchObject({
      status: 302,
      location: '/login',
    })
  })

  it('shows the current name (the founding one until set here) and no logo', async () => {
    expect(await load(ev() as never)).toEqual({
      company: { name: 'Founding Name', logo: null },
      share: null,
      signals: { status: expect.objectContaining({ enabled: true }), canSwitch: false },
    })
  })

  it('saves the name, which then is the company name', async () => {
    roleMock.mockResolvedValue('owner')
    expect(await actions.saveName!(ev(nameForm('  Kindred Digital Labs ')))).toEqual({
      action: 'saveName',
      ok: true,
    })
    expect(await load(ev() as never)).toMatchObject({ company: { name: 'Kindred Digital Labs' } })
  })

  it('refuses an empty name with the reason', async () => {
    expect(await actions.saveName!(ev(nameForm('   ')))).toMatchObject({
      status: 400,
      data: {
        action: 'saveName',
        error: 'The company name is required.',
        agent: {
          attempted: 'Saving the company name in Settings → Company',
          input: { name: '   ' },
        },
      },
    })
  })

  it('uploads a raster logo with its crop, keeps the original, and crops it again later', async () => {
    const first = await png()
    const crop = { left: 0, top: 0, size: 48 }
    expect(await actions.uploadLogo!(ev(logoForm(first, 'image/png', 'logo.png', crop)))).toEqual({
      action: 'uploadLogo',
      ok: true,
    })
    const blobs = storage.blobs as ReturnType<typeof memoryBlobs>
    const data = (await load(ev() as never)) as {
      company: { logo: { url: string; mime: string; original: unknown } | null }
    }
    const cutSha = blobs.shas().find((s) => s !== sha256Hex(first))!
    expect(data.company.logo).toEqual({
      url: `/api/company/logo/${cutSha}`,
      mime: 'image/png',
      original: { url: `/api/company/logo/${sha256Hex(first)}`, crop },
    })

    const recrop = new FormData()
    recrop.set('crop', JSON.stringify({ left: 8, top: 8, size: 32 }))
    expect(await actions.recropLogo!(ev(recrop))).toEqual({ action: 'recropLogo', ok: true })
    const again = (await load(ev() as never)) as {
      company: { logo: { url: string; original: { crop: unknown } } }
    }
    expect(again.company.logo.original.crop).toEqual({ left: 8, top: 8, size: 32 })
    expect(again.company.logo.url).not.toBe(`/api/company/logo/${cutSha}`)
    // The first cut went; the original stays.
    expect(blobs.shas()).toHaveLength(2)
    expect(blobs.shas()).toContain(sha256Hex(first))
    expect(blobs.shas()).not.toContain(cutSha)
  })

  it('refuses a raster logo without a usable crop, and a re-crop with no original', async () => {
    expect(await actions.uploadLogo!(ev(logoForm(await png(), 'image/png')))).toMatchObject({
      status: 400,
      data: { action: 'uploadLogo', error: 'Position the logo in the frame, then save.' },
    })
    expect(
      await actions.uploadLogo!(
        ev(logoForm(await png(), 'image/png', 'logo.png', { left: 0, top: 0, size: 2 })),
      ),
    ).toMatchObject({
      status: 400,
      data: { action: 'uploadLogo', error: expect.stringContaining('too small') },
    })
    const recrop = new FormData()
    recrop.set('crop', JSON.stringify({ left: 0, top: 0, size: 32 }))
    expect(await actions.recropLogo!(ev(recrop))).toMatchObject({
      status: 400,
      data: {
        action: 'recropLogo',
        error: 'This logo has no kept original to crop again; upload it again.',
      },
    })
    expect((storage.blobs as ReturnType<typeof memoryBlobs>).shas()).toEqual([])
  })

  it('uploads, replaces and removes the logo', async () => {
    const first = await png()
    expect(
      await actions.uploadLogo!(
        ev(logoForm(first, 'image/png', 'logo.png', { left: 0, top: 0, size: 48 })),
      ),
    ).toEqual({ action: 'uploadLogo', ok: true })
    expect(
      ((await load(ev() as never)) as { company: { logo: { mime: string } | null } }).company.logo,
    ).toMatchObject({ mime: 'image/png' })

    const svg = new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 10"><rect width="20" height="10"/></svg>',
    )
    expect(await actions.uploadLogo!(ev(logoForm(svg, 'image/svg+xml', 'logo.svg')))).toEqual({
      action: 'uploadLogo',
      ok: true,
    })
    const blobs = storage.blobs as ReturnType<typeof memoryBlobs>
    // The SVG replaced the cut and its original.
    expect(blobs.shas()).toHaveLength(1)
    expect(blobs.shas()).not.toContain(sha256Hex(first))

    expect(await actions.removeLogo!(ev())).toEqual({ action: 'removeLogo', ok: true })
    expect(blobs.shas()).toEqual([])
    expect(await load(ev() as never)).toMatchObject({ company: { logo: null } })
  })

  it('refuses a logo that is not an allowed image, with the reason, storing nothing', async () => {
    expect(
      await actions.uploadLogo!(
        ev(logoForm(new TextEncoder().encode('GIF89a'), 'image/gif', 'x.gif')),
      ),
    ).toMatchObject({
      status: 415,
      data: { action: 'uploadLogo' },
    })
    const scripted = new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    )
    expect(
      await actions.uploadLogo!(ev(logoForm(scripted, 'image/svg+xml', 'x.svg'))),
    ).toMatchObject({
      status: 400,
      data: { action: 'uploadLogo', error: expect.stringContaining('scripts') },
    })
    expect(await actions.uploadLogo!(ev(new FormData()))).toMatchObject({
      status: 400,
      data: { action: 'uploadLogo', error: 'Choose an image file to upload.' },
    })
    expect((storage.blobs as ReturnType<typeof memoryBlobs>).shas()).toEqual([])
  })

  it('sharing with the makers: the owner sees the status and switches it; an admin neither sees nor switches it', async () => {
    expect(((await load(ev() as never)) as { share: unknown }).share).toBeNull()
    expect(await actions.setSharing!(ev(sharingForm('off')))).toMatchObject({
      status: 403,
      data: {
        action: 'setSharing',
        error: expect.stringContaining('only the owner'),
        agent: {
          input: { enabled: false, withdraw: false },
          nextSteps: expect.arrayContaining([
            expect.stringContaining('ContributeError code "forbidden"'),
          ]),
        },
      },
    })
    roleMock.mockResolvedValue('owner')
    expect(((await load(ev() as never)) as { share: unknown }).share).toMatchObject({
      enabled: true,
      notConfigured: HUB_NOT_CONFIGURED,
      waiting: 0,
    })
    expect(await actions.setSharing!(ev(sharingForm('off')))).toEqual({
      action: 'setSharing',
      ok: true,
    })
    expect(((await load(ev() as never)) as { share: { enabled: boolean } }).share.enabled).toBe(
      false,
    )
    expect(await actions.setSharing!(ev(sharingForm('maybe')))).toMatchObject({ status: 400 })
    expect(await actions.setSharing!(ev(sharingForm('on', true)))).toMatchObject({
      status: 400,
      data: { error: expect.stringContaining('withdraw') },
    })
    expect(await actions.setSharing!(ev(sharingForm('on')))).toEqual({
      action: 'setSharing',
      ok: true,
    })
  })

  it('product signals: owner and admins see them; only the owner switches (traces.settings_set)', async () => {
    const signals = async () => ((await load(ev() as never)) as { signals: { status: { enabled: boolean }; canSwitch: boolean } }).signals
    expect(await signals()).toMatchObject({ status: { enabled: true }, canSwitch: false })
    expect(await actions.setSignals!(ev(sharingForm('off')))).toMatchObject({ status: 403, data: { action: 'setSignals' } })
    roleMock.mockResolvedValue('owner')
    expect(await signals()).toMatchObject({ canSwitch: true })
    expect(await actions.setSignals!(ev(sharingForm('off')))).toEqual({ action: 'setSignals', ok: true })
    expect((await signals()).status.enabled).toBe(false)
    expect(await actions.setSignals!(ev(sharingForm('maybe')))).toMatchObject({ status: 400 })
  })
})
