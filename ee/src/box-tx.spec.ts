import { describe, expect, it } from 'vitest'
import { boxTransactionDeps, pruneReleases } from './box-tx.ts'
import { EeUnreachableError, type Call } from './control-client.ts'
import { EE_LINK, EE_PREVIOUS } from './ee-slots.ts'
import { PATHS } from './paths.ts'
import type { RunResult, System } from './system.ts'

class Box implements System {
  files = new Map<string, string>()
  links = new Map<string, string>([
    [EE_LINK, '/opt/ee/releases/eigenenterprise-0.5.41-aaaaaaaaaaaa/ee.mjs'],
    [EE_PREVIOUS, '/opt/ee/releases/eigenenterprise-0.5.40-bbbbbbbbbbbb/ee.mjs'],
  ])
  calls: string[] = []
  ls: Record<string, string[]> = {}
  active = new Set<string>()
  async readFile(p: string) {
    return this.files.get(p) ?? null
  }
  async writeFile(p: string, c: string) {
    this.files.set(p, c)
  }
  async mkdirp() {}
  async exists(p: string) {
    return this.files.has(p)
  }
  async remove(p: string) {
    this.calls.push(`remove ${p}`)
  }
  async sha256File(p: string) {
    return (p.includes('0.5.41') ? 'a' : p.includes('0.5.40') ? 'b' : 'c').repeat(64)
  }
  async run(cmd: string, args: string[]): Promise<RunResult> {
    this.calls.push(`${cmd} ${args.join(' ')}`)
    if (cmd === 'readlink') {
      const t = this.links.get(args[0]!)
      return t ? { code: 0, stdout: `${t}\n`, stderr: '' } : { code: 1, stdout: '', stderr: '' }
    }
    if (cmd === 'ln') this.links.set(args[2]!, args[1]!)
    if (cmd === 'mv') {
      this.links.set(args[2]!, this.links.get(args[1]!)!)
      this.links.delete(args[1]!)
    }
    if (cmd === 'ls') return { code: 0, stdout: (this.ls[args[1]!] ?? []).join('\n') + '\n', stderr: '' }
    if (cmd === 'systemctl' && args[0] === 'is-active') return { code: this.active.has(args.at(-1)!) ? 0 : 3, stdout: '', stderr: '' }
    return { code: 0, stdout: '', stderr: '' }
  }
  async httpOk() {
    return true
  }
  async caddyLoad() {}
  async sleep() {}
  now() {
    return new Date('2026-11-24T10:00:00Z')
  }
}

const daemon = (answers: Record<string, { status: number; data: unknown } | Error>): { call: Call; asked: string[] } => {
  const asked: string[] = []
  return {
    asked,
    call: async (method, path, body) => {
      asked.push(`${method} ${path} ${body === undefined ? '' : JSON.stringify(body)}`.trim())
      const a = answers[`${method} ${path}`]
      if (!a) throw new Error(`unexpected ${method} ${path}`)
      if (a instanceof Error) throw a
      return a
    },
  }
}

describe('the off-box backup before an upgrade', () => {
  it('none set up: nothing runs', async () => {
    const d = daemon({ 'GET /v1/backups': { status: 200, data: { configured: false } } })
    expect(await boxTransactionDeps({ sys: new Box(), call: d.call }).offBoxBackup()).toEqual({ configured: false })
    expect(d.asked).toEqual(['GET /v1/backups'])
  })
  it('set up: ee runs one and waits for it', async () => {
    const d = daemon({
      'GET /v1/backups': { status: 200, data: { configured: true } },
      'POST /v1/backups/run': { status: 200, data: { run: { id: 'r1', status: 'succeeded', error: null } } },
    })
    expect(await boxTransactionDeps({ sys: new Box(), call: d.call }).offBoxBackup()).toEqual({ configured: true, ok: true, id: 'r1' })
    expect(d.asked[1]).toBe('POST /v1/backups/run {"author":"ee-upgrade","trigger":"manual","wait":true}')
  })
  it('a failed run or a refused start is a failed backup, with its sentence', async () => {
    const failed = daemon({
      'GET /v1/backups': { status: 200, data: { configured: true } },
      'POST /v1/backups/run': { status: 200, data: { run: { id: 'r1', status: 'failed', error: 'bucket gone' } } },
    })
    expect(await boxTransactionDeps({ sys: new Box(), call: failed.call }).offBoxBackup()).toEqual({ configured: true, ok: false, error: 'bucket gone' })
    const busy = daemon({
      'GET /v1/backups': { status: 200, data: { configured: true } },
      'POST /v1/backups/run': { status: 409, data: { title: 'a backup is running' } },
    })
    expect(await boxTransactionDeps({ sys: new Box(), call: busy.call }).offBoxBackup()).toEqual({ configured: true, ok: false, error: 'a backup is running' })
  })
})

describe('the rollback ee asks the daemon for', () => {
  it('asks the daemon (automatic: the update itself rolls back)', async () => {
    const d = daemon({ 'POST /v1/upgrade/rollback': { status: 200, data: { from: 'x', to: 'eigenenterprise-0.5.40-bbbbbbbbbbbb-linux-arm64.tar.gz' } } })
    expect(await boxTransactionDeps({ sys: new Box(), call: d.call }).rollback('watch failed')).toBe('eigenenterprise-0.5.40-bbbbbbbbbbbb-linux-arm64.tar.gz')
    expect(d.asked).toEqual(['POST /v1/upgrade/rollback {"author":"ee-upgrade","reason":"watch failed","automatic":true}'])
  })
  it('a refusal (the floor) comes back as its sentence', async () => {
    const d = daemon({ 'POST /v1/upgrade/rollback': { status: 409, data: { title: '0.5.40 is below the downgrade floor 0.5.41' } } })
    await expect(boxTransactionDeps({ sys: new Box(), call: d.call }).rollback('x')).rejects.toThrow('0.5.40 is below the downgrade floor 0.5.41')
  })
  it('a new ee that does not answer: the ee before it is put back (its A/B slot) and asked instead', async () => {
    const box = new Box()
    let n = 0
    const call: Call = async () => {
      if (n++ < 2) throw new EeUnreachableError('ee daemon unreachable')
      return { status: 200, data: { to: 'eigenenterprise-0.5.40-bbbbbbbbbbbb-linux-arm64.tar.gz' } }
    }
    expect(await boxTransactionDeps({ sys: box, call, sleep: async () => undefined }).rollback('ee.service crash-looped')).toMatch(/0\.5\.40/)
    expect(box.links.get(EE_LINK)).toBe('/opt/ee/releases/eigenenterprise-0.5.40-bbbbbbbbbbbb/ee.mjs')
    expect(box.links.get(EE_PREVIOUS)).toBe('/opt/ee/releases/eigenenterprise-0.5.41-aaaaaaaaaaaa/ee.mjs')
    expect(box.calls).toContain('systemctl restart ee.service')
  })
  it('no earlier ee kept: fails loud', async () => {
    const box = new Box()
    box.links.delete(EE_PREVIOUS)
    const call: Call = async () => Promise.reject(new EeUnreachableError('ee daemon unreachable'))
    await expect(boxTransactionDeps({ sys: box, call }).rollback('x')).rejects.toThrow(/no earlier ee is kept/)
  })
})

describe('preflight hands', () => {
  it('a restore running (its unit, or its job) makes the box busy', async () => {
    const box = new Box()
    const tx = boxTransactionDeps({ sys: box, call: daemon({}).call })
    expect(await tx.busy()).toBeNull()
    box.files.set(PATHS.restoreState, JSON.stringify({ version: 1, job: { kind: 'restore', status: 'running' } }))
    expect(await tx.busy()).toBe('a restore is running; wait for it to finish')
    box.files.set(PATHS.restoreState, JSON.stringify({ version: 1, job: { kind: 'check', status: 'running' } }))
    expect(await tx.busy()).toBeNull()
    box.active.add('ee-restore.service')
    expect(await tx.busy()).toBe('a restore is running; wait for it to finish')
  })
  it('a capability is installed when its program is there; one ee does not know is not', async () => {
    const box = new Box()
    const tx = boxTransactionDeps({ sys: box, call: daemon({}).call })
    expect(await tx.capabilityInstalled('chromium')).toBe(false)
    box.files.set('/opt/ee/capabilities/chromium/chrome-headless-shell', '')
    expect(await tx.capabilityInstalled('chromium')).toBe(true)
    expect(await tx.capabilityInstalled('ffmpeg')).toBe(false)
  })
})

describe('pruneReleases: the last two releases stay on disk', () => {
  it('removes older os tarballs, their kept metadata and unpacked releases; keeps livekit and what a slot names', async () => {
    const box = new Box()
    box.ls[PATHS.releases] = [
      'eigenenterprise-0.5.39-cccccccccccc-linux-arm64.tar.gz',
      'eigenenterprise-0.5.39-cccccccccccc.release',
      'eigenenterprise-0.5.40-bbbbbbbbbbbb-linux-arm64.tar.gz',
      'eigenenterprise-0.5.41-aaaaaaaaaaaa-linux-arm64.tar.gz',
      'eigenenterprise-0.5.41-aaaaaaaaaaaa.release',
      'livekit-server-1.13.11-linux-arm64.tar.gz',
    ]
    box.ls[`${PATHS.workloads}/os/releases`] = ['a'.repeat(16), 'b'.repeat(16), 'c'.repeat(16), 'd'.repeat(16), `${'e'.repeat(16)}.partial-12-ab`]
    box.files.set(
      PATHS.journal,
      JSON.stringify({
        version: 1,
        workloads: { os: { basePort: 4100, active: 'a', slots: { a: { release: 'a'.repeat(16), fingerprint: 'f', port: 4100 }, b: { release: 'd'.repeat(16), fingerprint: 'g', port: 4101 } } } },
        caddyFingerprint: null,
        appliedRev: null,
        events: [],
      }),
    )
    const removed = await pruneReleases(box, ['eigenenterprise-0.5.41-aaaaaaaaaaaa-linux-arm64.tar.gz', 'eigenenterprise-0.5.40-bbbbbbbbbbbb-linux-arm64.tar.gz'])
    expect(removed).toEqual(['eigenenterprise-0.5.39-cccccccccccc-linux-arm64.tar.gz', 'eigenenterprise-0.5.39-cccccccccccc.release', `os/releases/${'c'.repeat(16)}`])
  })
})
