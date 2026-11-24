import { describe, expect, it } from 'vitest'
import { generateKeyPairSync, sign } from 'node:crypto'
import { sha256Hex } from './release-key.ts'
import { legacyMeta } from './release-meta.ts'
import { RELEASES_URL, upgrade, type TransactionDeps, type UpgradeDeps, type UpgradeOutcome } from './upgrade.ts'
import { DEFAULT_WATCH } from './upgrade-watch.ts'

/**
 * The upgrade transaction on the box (plan/phase-upgrades.md §6.4), one spec per failure path.
 * The release is one since 0.5.40: its signed manifest lists UPGRADE.json, livekit and chromium.
 */

const KEY = generateKeyPairSync('ed25519')
const KEY_PEM = KEY.publicKey.export({ type: 'spki', format: 'pem' }).toString()
const NEW = 'eigenenterprise-0.5.41-aaaaaaaaaaaa'
const NEW_TARBALL = `${NEW}-linux-arm64.tar.gz`
const OLD = 'eigenenterprise-0.5.40-bbbbbbbbbbbb-linux-arm64.tar.gz'
const INSTALL_SH = '#!/bin/sh\necho install\n'
const DIR = '/var/lib/ee/upgrades/2026-11-10T15-30-00Z'
const META = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ release: NEW, downgradeFloor: '0.5.40', minFrom: '0.5.20', capabilities: ['chromium'], ...over })
const ASSETS = ['livekit-server-1.13.11-linux-arm64.tar.gz', 'chromium-headless-shell-1217-linux-arm64.tar.gz']

function release(opts: { meta?: string | null; assets?: string[] } = {}) {
  const meta = opts.meta === undefined ? META() : opts.meta
  const lines = [`${sha256Hex(`${NEW}\n`)}  LATEST`, `${sha256Hex(INSTALL_SH)}  install.sh`]
  if (meta !== null) lines.push(`${sha256Hex(meta)}  UPGRADE.json`)
  for (const a of opts.assets ?? ASSETS) lines.push(`${'0'.repeat(64)}  ${a}`)
  const sums = lines.join('\n') + '\n'
  return { sums, sig: sign(null, Buffer.from(sums), KEY.privateKey).toString('base64'), meta }
}

const healthySample = () => ({ units: { 'ee-os-b.service': { active: 'active', restarts: 0 } }, edge: { total: 0, errors: 0 }, queue: { overdue: 0, startedSince: 0 } })

function run(tx: Partial<TransactionDeps> = {}, r = release(), over: Partial<UpgradeDeps> = {}, current: string | null = OLD) {
  const calls: string[] = []
  const logs: string[] = []
  const outcomes: UpgradeOutcome[] = []
  const reported: UpgradeOutcome[] = []
  let installed = current
  const deps: UpgradeDeps = {
    fetchText: async (url) => {
      calls.push(`fetch ${url}`)
      if (url.endsWith('/SHA256SUMS')) return r.sums
      if (url.endsWith('/SHA256SUMS.sig')) return `${r.sig}\n`
      if (url.endsWith('/UPGRADE.json')) return r.meta ?? ''
      return `${NEW}\n`
    },
    download: async (url, dest) => void calls.push(`download ${url} -> ${dest}`),
    sha256File: async () => sha256Hex(INSTALL_SH),
    releaseKeyPem: KEY_PEM,
    run: async (cmd, args) => (calls.push(`run ${cmd} ${args.join(' ')}`), { code: 0, stderr: '' }),
    runLive: async (cmd, args) => {
      calls.push(`live ${cmd} ${args.join(' ')}`)
      installed = NEW_TARBALL // the installer's bootstrap names the new release in the company repo
      return 0
    },
    installed: async () => installed,
    listUpgrades: async () => [],
    mkdirp: async (p) => void calls.push(`mkdir ${p}`),
    writeFile: async (p) => void calls.push(`write ${p}`),
    remove: async (p) => void calls.push(`remove ${p}`),
    now: () => new Date('2026-11-10T15:30:00Z'),
    log: (l) => void logs.push(l),
    tx: {
      freeBytes: async () => 100 * 1024 ** 3,
      databaseBytes: async () => 1024 ** 3,
      capabilityInstalled: async () => true,
      busy: async () => null,
      installedMeta: async (rel) => legacyMeta(rel),
      storeMeta: async () => undefined,
      offBoxBackup: async () => ({ configured: false }),
      watchProbe: { sample: async () => healthySample() },
      watchLimits: { ...DEFAULT_WATCH, durationMs: 0 },
      sleep: async () => undefined,
      rollback: async () => OLD,
      keepReleases: async () => undefined,
      moduleImpact: async () => [],
      moduleCheck: async () => [],
      report: async (o) => void reported.push(o),
      ...tx,
    },
    ...over,
  }
  const go = () => upgrade(deps, { from: RELEASES_URL, arch: 'arm64', check: false, onOutcome: async (o) => void outcomes.push(o) })
  const changed = () => calls.filter((c) => /^(mkdir|run|write|live|download|remove)/.test(c))
  return { deps, calls, logs, go, outcomes, reported, changed, setInstalled: (v: string | null) => void (installed = v) }
}

describe('1. preflight: refused with a sentence, nothing changed', () => {
  it('while a restore runs (reported like every other end)', async () => {
    const t = run({ busy: async () => 'a restore is running; wait for it to finish' })
    await expect(t.go()).rejects.toThrow('upgrade refused, nothing changed: a restore is running; wait for it to finish')
    expect(t.changed()).toEqual([])
    expect(t.outcomes).toEqual([
      { release: NEW, from: OLD, step: 'verifying', ok: false, reason: 'upgrade refused, nothing changed: a restore is running; wait for it to finish', rolledBack: false },
    ])
    expect(t.reported).toEqual(t.outcomes)
  })

  it('a signature that does not verify', async () => {
    const r = release()
    const t = run({}, { ...r, sig: sign(null, Buffer.from(r.sums), generateKeyPairSync('ed25519').privateKey).toString('base64') })
    await expect(t.go()).rejects.toThrow(/^upgrade refused, nothing changed: the release SHA256SUMS is not signed/)
    expect(t.changed()).toEqual([])
  })

  it('a release since 0.5.40 without signed upgrade metadata', async () => {
    const t = run({}, release({ meta: null }))
    await expect(t.go()).rejects.toThrow(/refused, nothing changed: .*carries no signed UPGRADE\.json/)
    expect(t.changed()).toEqual([])
  })

  it('a jump from below minFrom', async () => {
    const t = run({}, release({ meta: META({ minFrom: '0.5.41' }) }))
    await expect(t.go()).rejects.toThrow(/can only be installed on a server that runs 0\.5\.41 or newer; this one runs 0\.5\.40/)
    expect(t.changed()).toEqual([])
  })

  it('a downgrade below the floor kept for what runs now (the fleet can target an older release)', async () => {
    const t = run(
      { installedMeta: async (rel) => ({ ...legacyMeta(rel), downgradeFloor: '0.5.42', legacy: false }) },
      release(),
      {},
      'eigenenterprise-0.5.43-cccccccccccc-linux-arm64.tar.gz',
    )
    await expect(t.go()).rejects.toThrow(/0\.5\.41 is below the downgrade floor 0\.5\.42 of eigenenterprise-0\.5\.43/)
    expect(t.changed()).toEqual([])
  })

  it('kept metadata of what runs now that does not verify', async () => {
    const t = run({ installedMeta: async () => Promise.reject(new Error('the kept metadata of x does not verify')) })
    await expect(t.go()).rejects.toThrow('upgrade refused, nothing changed: the kept metadata of x does not verify')
    expect(t.changed()).toEqual([])
  })

  it('a capability the server lacks and the release does not ship', async () => {
    const t = run({ capabilityInstalled: async () => false }, release({ assets: ['livekit-server-1.13.11-linux-arm64.tar.gz'] }))
    await expect(t.go()).rejects.toThrow(/needs the chromium capability, which this server lacks and the release does not ship for linux-arm64/)
    expect(t.changed()).toEqual([])
  })

  it('a capability the server lacks but the release ships goes ahead (its installer installs it)', async () => {
    expect(await run({ capabilityInstalled: async () => false }).go()).toBe('upgraded')
  })

  it('a release that does not ship livekit for this CPU', async () => {
    const t = run({}, release({ assets: ['chromium-headless-shell-1217-linux-arm64.tar.gz', 'livekit-server-1.13.11-linux-x64.tar.gz'] }))
    await expect(t.go()).rejects.toThrow(/does not ship livekit-server for linux-arm64/)
    expect(t.changed()).toEqual([])
  })

  it('too little disk for the safety copy and the release', async () => {
    const t = run({ freeBytes: async () => 2 * 1024 ** 3, databaseBytes: async () => 5 * 1024 ** 3 })
    await expect(t.go()).rejects.toThrow(
      'upgrade refused, nothing changed: only 2.0 GB free on /var/lib/ee; the update needs 8.0 GB (a safety copy of the database plus the new release)',
    )
    expect(t.changed()).toEqual([])
  })

  it('module impact only annotates: a broken module or a failing hook never refuses', async () => {
    const t = run({ moduleImpact: async () => [{ module: 'invoices', status: 'broken', note: 'uses a removed tool' }] })
    expect(await t.go()).toBe('upgraded')
    expect(t.logs).toContain('  module invoices: broken — uses a removed tool')
    const failing = run({ moduleImpact: async () => Promise.reject(new Error('hub down')) })
    expect(await failing.go()).toBe('upgraded')
    expect(failing.logs.join('\n')).toContain('the module impact could not be computed: hub down')
  })
})

describe('2. safety copy: plus an off-box backup when backups are configured', () => {
  it('waits for the backup and goes on when it succeeded', async () => {
    const t = run({ offBoxBackup: async () => ({ configured: true, ok: true, id: 'run-1' }) })
    expect(await t.go()).toBe('upgraded')
    expect(t.logs).toContain('✓ off-box backup run-1 finished')
  })

  it('a failed backup refuses the update with a sentence, before the installer', async () => {
    const t = run({ offBoxBackup: async () => ({ configured: true, ok: false, error: 's3: 403 Forbidden' }) })
    await expect(t.go()).rejects.toThrow('upgrade stopped, nothing changed: the off-box backup failed: s3: 403 Forbidden')
    expect(t.calls.some((c) => c.startsWith('live') || c.startsWith('download'))).toBe(false)
    expect(t.outcomes).toMatchObject([{ step: 'backup', ok: false, rolledBack: false }])
  })

  it('a backup that cannot even start refuses the same way', async () => {
    const t = run({ offBoxBackup: async () => Promise.reject(new Error('ee daemon unreachable')) })
    await expect(t.go()).rejects.toThrow('the off-box backup failed: ee daemon unreachable')
    expect(t.calls.some((c) => c.startsWith('live'))).toBe(false)
  })

  it('no backups set up: says the local copy is the only one, and goes on', async () => {
    const t = run()
    expect(await t.go()).toBe('upgraded')
    expect(t.logs.join('\n')).toContain('the local safety copy is the only copy')
  })

  it('a failed local copy stops before anything else', async () => {
    const t = run({}, release(), { run: async () => ({ code: 1, stderr: 'disk full' }) })
    await expect(t.go()).rejects.toThrow('upgrade stopped, nothing changed: the safety copy failed (sh): disk full')
    expect(t.outcomes).toMatchObject([{ step: 'safety-copy', ok: false }])
  })
})

describe('3 + 4. the installer: green behind its health gate, the core smoke and its migrations', () => {
  it('keeps the release signed metadata on the box before the installer runs (its floor guards ee rollback)', async () => {
    const stored: string[] = []
    const t = run({ storeMeta: async (rel, f) => void stored.push(`${rel} ${f.meta === META()} ${f.sums === release().sums}`) })
    await t.go()
    expect(stored).toEqual([`${NEW} true true`])
    expect(t.calls.indexOf(`fetch ${RELEASES_URL}/UPGRADE.json`)).toBeLessThan(t.calls.findIndex((c) => c.startsWith('live')))
  })

  it('green failed (a migration or its gate) after the repo named it: the repo goes back to what serves, reported as rolled back', async () => {
    const reasons: string[] = []
    const t = run({ rollback: async (why) => (reasons.push(why), OLD) }, release(), {
      runLive: async () => {
        t.setInstalled(NEW_TARBALL) // the installer's bootstrap committed the new release, then its health gate failed
        return 1
      },
    })
    await expect(t.go()).rejects.toThrow(`the installer failed (exit 1); ${OLD} kept serving. Safety copy and rollback steps: ${DIR}/ROLLBACK.txt`)
    expect(reasons).toEqual([`the installer failed (exit 1); ${NEW_TARBALL} never went live`])
    expect(t.outcomes).toMatchObject([{ step: 'installing', ok: false, rolledBack: true }])
  })

  it('an installer that fails before it changed the repo leaves everything as it was', async () => {
    let rolled = false
    const t = run({ rollback: async () => ((rolled = true), OLD) }, release(), { runLive: async () => 2 })
    await expect(t.go()).rejects.toThrow(/installer failed \(exit 2\)\. The app that was running stays live/)
    expect(rolled).toBe(false)
    expect(t.outcomes).toMatchObject([{ step: 'installing', ok: false, rolledBack: false }])
  })

  it('an installer that exits 0 but did not put the release in the company repo is a failure', async () => {
    const t = run({}, release(), { runLive: async () => 0 })
    await expect(t.go()).rejects.toThrow(`the installer finished, but the company repo runs ${OLD}, not ${NEW_TARBALL}`)
  })
})

describe('5. cut-over, then the watch; 6. rollback if it fails', () => {
  it('a failed watch rolls back to the release before (no restore) and says so', async () => {
    const reasons: string[] = []
    let n = 0
    const t = run({
      watchLimits: { ...DEFAULT_WATCH, durationMs: 60_000, intervalMs: 10_000 },
      watchProbe: {
        sample: async () => ({ ...healthySample(), units: { 'ee-os-b.service': { active: 'active', restarts: n++ === 0 ? 0 : 5 } } }),
      },
      rollback: async (why) => (reasons.push(why), OLD),
    })
    await expect(t.go()).rejects.toThrow(`the update to ${NEW} was rolled back: ee-os-b.service crash-looped (5 restarts since the cut-over); ${OLD} serves again`)
    expect(reasons).toEqual([`the watch after the update to ${NEW} failed: ee-os-b.service crash-looped (5 restarts since the cut-over)`])
    expect(t.outcomes).toMatchObject([{ release: NEW, from: OLD, step: 'rolling-back', ok: false, rolledBack: true }])
    expect(t.calls.some((c) => c.includes('pg_restore'))).toBe(false)
  })

  it('a rollback that fails too points at the safety copy', async () => {
    const t = run({
      watchProbe: { sample: async () => Promise.reject(new Error('caddy: no such socket')) },
      rollback: async () => Promise.reject(new Error('blue did not come back')),
    })
    await expect(t.go()).rejects.toThrow(
      `the update to ${NEW} failed its watch (could not watch the new release: caddy: no such socket) and the rollback failed too: blue did not come back. Safety copy and rollback steps: ${DIR}/ROLLBACK.txt`,
    )
    expect(t.outcomes).toMatchObject([{ step: 'rolling-back', ok: false, rolledBack: false }])
  })

  it('the module check runs after the cut-over and only reports: a broken module never rolls the core back', async () => {
    let rolled = false
    const t = run({ moduleCheck: async () => [{ module: 'invoices', status: 'broken', note: 'its tests fail' }], rollback: async () => ((rolled = true), OLD) })
    expect(await t.go()).toBe('upgraded')
    expect(rolled).toBe(false)
    expect(t.logs).toContain('  module invoices: broken — its tests fail')
  })

  it('a held watch keeps the last two releases on disk and reports ok', async () => {
    const kept: string[][] = []
    const t = run({ keepReleases: async (k) => void kept.push(k) })
    expect(await t.go()).toBe('upgraded')
    expect(kept).toEqual([[NEW_TARBALL, OLD]])
    expect(t.outcomes).toEqual([{ release: NEW, from: OLD, step: 'done', ok: true, reason: null, rolledBack: false }])
    expect(t.reported).toEqual(t.outcomes)
  })
})
