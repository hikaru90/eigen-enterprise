import type { RunResult, System } from './system.ts'
import { createHash } from 'node:crypto'

/**
 * In-memory box for the preview tests (previews.spec.ts, daemon.spec.ts):
 * files, archives by content, unit states, and a scripted dev server that
 * starts listening some time after its unit starts.
 */
export class PreviewBox implements System {
  files = new Map<string, string>()
  symlinks = new Set<string>()
  /** Tarball content → the files it unpacks to. */
  archives = new Map<string, Record<string, string>>()
  units = new Map<string, string>()
  commands: string[][] = []
  /** Exit code of the install unit (systemd-run --wait). */
  installExit = 0
  /** Runs while the install unit "runs" (e.g. to stop the preview meanwhile). */
  duringInstall: (() => Promise<void>) | null = null
  /** unit → journal lines. */
  journals = new Map<string, string[]>()
  /** Ports other processes already listen on (ss -ltnH). */
  usedPorts: number[] = []
  /** What the dev server does once its unit runs: listen on these addresses after a delay, or exit. */
  devServer: { afterMs: number; listen: string[] } | { afterMs: number; exit: true } | null = { afterMs: 3000, listen: ['127.0.0.1:5173'] }
  /** Leftover units systemctl list-units reports (ee start). */
  leftovers: string[] = []
  clock = Date.parse('2026-11-20T10:00:00Z')
  private devStartedAt = new Map<string, number>()

  async readFile(p: string) {
    return this.files.get(p) ?? null
  }
  async writeFile(p: string, c: string) {
    this.files.set(p, c)
  }
  async mkdirp() {}
  async exists(p: string) {
    return [...this.files.keys()].some((k) => k === p || k.startsWith(p + '/'))
  }
  async remove(p: string) {
    for (const k of [...this.files.keys()]) if (k === p || k.startsWith(p + '/')) this.files.delete(k)
  }
  async sha256File(p: string) {
    const c = this.files.get(p)
    if (c === undefined) throw new Error(`ENOENT ${p}`)
    return createHash('sha256').update(c).digest('hex')
  }
  async httpOk() {
    return true
  }
  caddyLoads: unknown[] = []
  async caddyLoad(config: unknown) {
    this.caddyLoads.push(config)
  }
  async sleep(ms: number) {
    this.clock += ms
  }
  now() {
    return new Date(this.clock)
  }

  ran(cmd: string): string[][] {
    return this.commands.filter((c) => c[0] === cmd)
  }

  private dev(unit: string): { pid: number; lines: string[]; exited: boolean } {
    const started = this.devStartedAt.get(unit)
    const d = this.devServer
    if (started === undefined || !d || this.clock - started < d.afterMs) return { pid: 4242, lines: [], exited: false }
    if ('exit' in d) return { pid: 4242, lines: [], exited: true }
    return { pid: 4242, lines: d.listen.map((a) => `LISTEN 0      511    ${a}   0.0.0.0:*    users:(("node",pid=4242,fd=20))`), exited: false }
  }

  async run(cmd: string, args: string[]): Promise<RunResult> {
    this.commands.push([cmd, ...args])
    const ok = (stdout = ''): RunResult => ({ code: 0, stdout, stderr: '' })
    if (cmd === 'stat') {
      const p = args.at(-1)!
      if (this.symlinks.has(p)) return ok('symbolic link\n')
      return this.files.has(p) ? ok('regular file\n') : { code: 1, stdout: '', stderr: `stat: cannot statx '${p}': No such file or directory` }
    }
    if (cmd === 'cp') {
      const [src, dst] = args.slice(-2) as [string, string]
      const c = this.files.get(src)
      if (c === undefined) return { code: 1, stdout: '', stderr: 'no such file' }
      this.files.set(dst, c)
      if (this.symlinks.has(src)) this.symlinks.add(dst)
      return ok()
    }
    if (cmd === 'tar') {
      const src = args[args.indexOf('-xzf') + 1]!
      const dir = args[args.indexOf('-C') + 1]!
      const content = this.archives.get(this.files.get(src) ?? '')
      if (!content) return { code: 2, stdout: '', stderr: 'tar: not an archive' }
      for (const [rel, text] of Object.entries(content)) this.files.set(`${dir}/${rel}`, text)
      return ok()
    }
    if (cmd === 'ss') {
      const lines = this.usedPorts.map((p) => `LISTEN 0 4096 127.0.0.1:${p} 0.0.0.0:* users:(("other",pid=1,fd=3))`)
      for (const [unit, state] of this.units) if (state === 'active') lines.push(...this.dev(unit).lines)
      return ok(lines.join('\n') + (lines.length ? '\n' : ''))
    }
    if (cmd === 'journalctl') return ok((this.journals.get(args[args.indexOf('-u') + 1]!.replace(/\.service$/, '')) ?? []).join('\n'))
    if (cmd === 'systemd-run') {
      const unit = args.find((a) => a.startsWith('--unit='))!.slice('--unit='.length)
      if (args.includes('--wait')) {
        this.units.set(unit, 'active')
        if (this.duringInstall) await this.duringInstall()
        const stopped = this.units.get(unit) !== 'active'
        this.units.delete(unit)
        return stopped ? { code: 143, stdout: '', stderr: '' } : { code: this.installExit, stdout: '', stderr: '' }
      }
      this.units.set(unit, 'active')
      this.devStartedAt.set(unit, this.clock)
      this.files.set(`/sys/fs/cgroup/system.slice/${unit}.service/cgroup.procs`, '4242\n')
      return ok()
    }
    if (cmd === 'systemctl') {
      const [verb] = args
      const unit = (args.at(-1) ?? '').replace(/\.service$/, '')
      if (verb === 'list-units') return ok(this.leftovers.map((u) => `${u} loaded active running ${u}`).join('\n'))
      if (verb === 'show') return ok(this.units.get(unit) === 'active' ? `/system.slice/${unit}.service\n` : '\n')
      if (verb === 'is-active') {
        let state = this.units.get(unit) ?? 'inactive'
        if (state === 'active' && this.dev(unit).exited) {
          state = 'failed'
          this.units.set(unit, 'failed')
        }
        return { code: state === 'active' ? 0 : 3, stdout: `${state}\n`, stderr: '' }
      }
      if (verb === 'stop') {
        for (const u of args.slice(1)) {
          const name = u.replace(/\.service$/, '')
          if (this.units.has(name)) this.units.set(name, 'inactive')
        }
        this.leftovers = []
        return ok()
      }
      return ok()
    }
    return ok()
  }
}
