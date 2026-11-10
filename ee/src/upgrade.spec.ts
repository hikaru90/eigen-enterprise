import { describe, expect, it } from 'vitest'
import { AGE_REPAIR_SQL } from './age-repair.ts'
import { latestTarball, RELEASES_URL, rollbackSteps, upgrade, type UpgradeDeps } from './upgrade.ts'

const LATEST = 'eigenenterprise-0.4.0-1bb02b405565'

function fake(
  opts: { current?: string | null; latest?: string; upgradesDir?: string[] } = {},
  over: Partial<UpgradeDeps> = {},
) {
  const calls: string[] = []
  const logs: string[] = []
  const dirs = [...(opts.upgradesDir ?? [])]
  const deps: UpgradeDeps = {
    fetchText: async (url) => {
      calls.push(`fetch ${url}`)
      return `${opts.latest ?? LATEST}\n`
    },
    download: async (url, dest) => void calls.push(`download ${url} -> ${dest}`),
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
      `mkdir ${dir}`,
      `run sh -c runuser -u postgres -- pg_dump -Fc os > '${dir}/os.dump'`,
      `run tar -czf ${dir}/ee-state.tgz -C / var/lib/ee/company var/lib/ee/secrets.enc etc/ee`,
      `write ${dir}/ROLLBACK.txt`,
      `download ${RELEASES_URL}/install.sh -> ${dir}/install.sh`,
      `live sh ${dir}/install.sh --from ${RELEASES_URL}`,
    ])
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
