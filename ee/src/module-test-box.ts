import type { RunResult, System } from './system.ts'
import { createHash } from 'node:crypto'
import { readBundle } from '../../contracts/module-bundle.ts'

/**
 * In-memory box for the module tests (modules.spec.ts): text files, binary
 * files (bundles), unit states and a fake clock. `tar -x` really reads the
 * bundle (contracts/module-bundle.ts), so a release holds the bundle's files.
 */
export class ModuleBox implements System {
  files = new Map<string, string>()
  bytes = new Map<string, Buffer>()
  units = new Map<string, string>()
  restarts = new Map<string, number>()
  journals = new Map<string, string[]>()
  commands: string[][] = []
  /** Exit code (and output) of a module test step. */
  testExit = 0
  testOutput = 'ok hello'
  /** Runs while a test step "runs" (to hold a deploy in flight). */
  duringTest: (() => Promise<void>) | null = null
  /** A started module unit crashes (failed). */
  crash = false
  clock = Date.parse('2026-11-24T10:00:00Z')

  async readFile(p: string) {
    return this.files.get(p) ?? null
  }
  async writeFile(p: string, c: string) {
    this.files.set(p, c)
  }
  async mkdirp() {}
  private keys(): string[] {
    return [...this.files.keys(), ...this.bytes.keys()]
  }
  async exists(p: string) {
    return this.keys().some((k) => k === p || k.startsWith(p + '/'))
  }
  async remove(p: string) {
    for (const m of [this.files, this.bytes] as Map<string, unknown>[]) {
      for (const k of [...m.keys()]) if (k === p || k.startsWith(p + '/')) m.delete(k)
    }
  }
  async sha256File(p: string) {
    const b = this.bytes.get(p) ?? (this.files.has(p) ? Buffer.from(this.files.get(p)!) : undefined)
    if (b === undefined) throw new Error(`ENOENT ${p}`)
    return createHash('sha256').update(b).digest('hex')
  }
  async readBytes(p: string): Promise<Uint8Array> {
    const b = this.bytes.get(p)
    if (b === undefined) throw new Error(`ENOENT ${p}`)
    return new Uint8Array(b)
  }
  async httpOk() {
    return true
  }
  async caddyLoad() {}
  async sleep(ms: number) {
    this.clock += ms
  }
  now() {
    return new Date(this.clock)
  }

  ran(cmd: string): string[][] {
    return this.commands.filter((c) => c[0] === cmd)
  }

  private move(from: string, to: string, copy: boolean) {
    for (const m of [this.files, this.bytes] as Map<string, unknown>[]) {
      for (const [k, v] of [...m.entries()]) {
        if (k === from || k.startsWith(from + '/')) {
          if (!copy) m.delete(k)
          m.set(to + k.slice(from.length), v)
        }
      }
    }
  }

  async run(cmd: string, args: string[]): Promise<RunResult> {
    this.commands.push([cmd, ...args])
    const ok = (stdout = ''): RunResult => ({ code: 0, stdout, stderr: '' })
    const paths = args.filter((a) => !a.startsWith('-'))
    if (cmd === 'stat') {
      const p = args.at(-1)!
      return this.bytes.has(p) || this.files.has(p) ? ok('regular file\n') : { code: 1, stdout: '', stderr: `stat: cannot statx '${p}'` }
    }
    if (cmd === 'cp') {
      const [src, dst] = paths.slice(-2) as [string, string]
      if (!(await this.exists(src))) return { code: 1, stdout: '', stderr: `cp: ${src}: no such file` }
      this.move(src, dst, true)
      return ok()
    }
    if (cmd === 'mv') {
      const [src, dst] = paths.slice(-2) as [string, string]
      this.move(src, dst, false)
      return ok()
    }
    if (cmd === 'ls') {
      const dir = args.at(-1)!
      const names = new Set(this.keys().filter((k) => k.startsWith(dir + '/')).map((k) => k.slice(dir.length + 1).split('/')[0]!))
      return names.size ? ok([...names].sort().join('\n') + '\n') : { code: 2, stdout: '', stderr: 'no such dir' }
    }
    if (cmd === 'tar') {
      const src = args[args.indexOf('-xzf') + 1]!
      const dir = args[args.indexOf('-C') + 1]!
      const b = this.bytes.get(src)
      if (!b) return { code: 2, stdout: '', stderr: 'tar: no such archive' }
      for (const e of readBundle(b).entries) if (e.type === 'file') this.files.set(`${dir}/${e.path}`, Buffer.from(e.content).toString('utf8'))
      return ok()
    }
    if (cmd === 'systemd-run') {
      const unit = args.find((a) => a.startsWith('--unit='))!.slice('--unit='.length)
      if (unit.startsWith('ee-mod-test-')) {
        if (this.duringTest) await this.duringTest()
        return { code: this.testExit, stdout: this.testOutput, stderr: '' }
      }
      return ok()
    }
    if (cmd === 'journalctl') return ok((this.journals.get(args[args.indexOf('-u') + 1]!) ?? []).join('\n'))
    if (cmd === 'systemctl') {
      const [verb] = args
      const unit = args.at(-1)!
      if (verb === 'is-active') {
        const s = this.units.get(unit) ?? 'inactive'
        return { code: s === 'active' ? 0 : 3, stdout: `${s}\n`, stderr: '' }
      }
      if (verb === 'show') {
        if (args.includes('NRestarts')) return ok(`${this.restarts.get(unit) ?? 0}\n`)
        return ok(this.units.get(unit) === 'failed' ? '1\n' : '0\n')
      }
      if (verb === 'restart' || verb === 'start') this.units.set(unit, this.crash ? 'failed' : 'active')
      if (verb === 'stop') this.units.set(unit, 'inactive')
      return ok()
    }
    return ok()
  }
}
