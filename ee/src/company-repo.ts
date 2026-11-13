import { isIP } from 'node:net'
import { hostPortCollisions, routesSchema, workloadSchema, type Route, type Workload } from './spec.ts'
import { mustRun, type System } from './system.ts'
import { z } from 'zod'
import { OFFICIAL_CONTRIBUTE_HUB } from './contribute-hub.ts'

function assertNoHostPortCollisions(workloads: Workload[]): void {
  const collisions = hostPortCollisions(workloads)
  if (collisions.length > 0) throw new Error(`company repo: host port collision: ${collisions.join('; ')}`)
}

/**
 * The company repo (D4): desired state as files in git. ee is its only writer;
 * every mutation is validate → write → commit, and reads come from HEAD only,
 * so a half-written file is never observed.
 */

export const settingsSchema = z
  .object({
    /** Console host (the operator surface). Drives the os workload's ORIGIN. */
    consoleHost: z.string().min(1),
    /** Public website host, if attached. */
    publicHost: z.string().min(1).nullable().default(null),
    acmeEmail: z.string().email().nullable().default(null),
    /** Calls signalling host (rtc.<console host> → livekit); follows the console host (domains.ts). */
    callsHost: z.string().min(1).nullable().default(null),
    /**
     * The IP LiveKit advertises to browsers for media (rtc.node_ip). Explicit, from
     * `ee bootstrap --node-ip`: never guessed (no STUN, no use_external_ip).
     */
    rtcNodeIp: z
      .string()
      .refine((ip) => isIP(ip) !== 0, { message: 'rtcNodeIp must be an IP address' })
      .nullable()
      .default(null),
    /**
     * The central Contribute board this install shares with, or `off`
     * (contribute-hub.ts). Missing on companies from before it existed: they
     * get the official board on their next upgrade.
     */
    contributeHub: z.union([z.literal('off'), z.url()]).default(OFFICIAL_CONTRIBUTE_HUB),
  })
  .strict()

export type Settings = z.infer<typeof settingsSchema>

export type DesiredState = {
  rev: string
  workloads: Workload[]
  routes: Route[]
  settings: Settings
}

export class CompanyRepo {
  constructor(
    private readonly sys: System,
    private readonly dir: string,
  ) {}

  private git(args: string[], input?: string): Promise<string> {
    return mustRun(this.sys, 'git', ['-C', this.dir, ...args], input === undefined ? {} : { input })
  }

  async init(): Promise<void> {
    if (await this.sys.exists(`${this.dir}/.git`)) return
    await this.sys.mkdirp(this.dir, 0o700)
    await this.git(['init', '-q', '-b', 'main'])
    await this.git(['config', 'user.name', 'ee'])
    await this.git(['config', 'user.email', 'ee@localhost'])
  }

  private async showAtHead(path: string): Promise<string | null> {
    const r = await this.sys.run('git', ['-C', this.dir, 'show', `HEAD:${path}`])
    if (r.code !== 0) return null
    return r.stdout
  }

  async head(): Promise<string | null> {
    const r = await this.sys.run('git', ['-C', this.dir, 'rev-parse', 'HEAD'])
    return r.code === 0 ? r.stdout.trim() : null
  }

  async read(): Promise<DesiredState> {
    const rev = await this.head()
    if (!rev) throw new Error('company repo has no commits yet — run `ee bootstrap`')
    const listing = await this.git(['ls-tree', '--name-only', 'HEAD', 'workloads/'])
    const workloads: Workload[] = []
    for (const path of listing.split('\n').filter((p) => p.endsWith('.json'))) {
      const raw = await this.showAtHead(path)
      if (raw === null) throw new Error(`company repo: ${path} listed but unreadable`)
      const parsed = workloadSchema.safeParse(JSON.parse(raw))
      if (!parsed.success) throw new Error(`company repo: ${path} is invalid: ${parsed.error.message}`)
      if (`workloads/${parsed.data.name}.json` !== path) {
        throw new Error(`company repo: ${path} declares name "${parsed.data.name}"`)
      }
      workloads.push(parsed.data)
    }
    assertNoHostPortCollisions(workloads)
    const routes = routesSchema.parse(JSON.parse((await this.showAtHead('routes.json')) ?? '[]'))
    const settingsRaw = await this.showAtHead('settings.json')
    if (settingsRaw === null) throw new Error('company repo: settings.json missing')
    const settings = settingsSchema.parse(JSON.parse(settingsRaw))
    return { rev, workloads, routes, settings }
  }

  /**
   * Apply a change and commit it. `mutate` gets the current state and returns the
   * next one; the result is validated in full before anything touches disk.
   */
  async commit(
    message: string,
    author: string,
    mutate: (s: Omit<DesiredState, 'rev'>) => Omit<DesiredState, 'rev'>,
  ): Promise<string> {
    const current = (await this.head())
      ? await this.read()
      : { rev: '', workloads: [], routes: [], settings: settingsSchema.parse({ consoleHost: 'unset' }) }
    const next = mutate({ workloads: current.workloads, routes: current.routes, settings: current.settings })
    const workloads = next.workloads.map((w) => workloadSchema.parse(w))
    assertNoHostPortCollisions(workloads)
    const routes = routesSchema.parse(next.routes)
    const settings = settingsSchema.parse(next.settings)
    const names = new Set(workloads.map((w) => w.name))
    for (const r of routes) {
      if (!names.has(r.workload)) throw new Error(`route ${r.host} points at unknown workload ${r.workload}`)
    }

    await this.git(['rm', '-q', '-r', '--cached', '--ignore-unmatch', 'workloads'])
    await this.sys.remove(`${this.dir}/workloads`)
    for (const w of workloads) {
      await this.sys.writeFile(`${this.dir}/workloads/${w.name}.json`, JSON.stringify(w, null, 2) + '\n', 0o600)
    }
    await this.sys.writeFile(`${this.dir}/routes.json`, JSON.stringify(routes, null, 2) + '\n', 0o600)
    await this.sys.writeFile(`${this.dir}/settings.json`, JSON.stringify(settings, null, 2) + '\n', 0o600)
    // Git mirrors (sources/) live beside the desired state, never in it: a
    // committed mirror bloats history and its refs get rewritten under ee.
    await this.sys.writeFile(`${this.dir}/.gitignore`, 'sources/\n', 0o600)
    await this.git(['rm', '-q', '-r', '--cached', '--ignore-unmatch', 'sources'])
    await this.git(['add', '-A'])
    const status = await this.git(['status', '--porcelain'])
    if (status.trim() === '') return (await this.head()) ?? ''
    const who = author.replace(/[^a-zA-Z0-9:._-]/g, '-').slice(0, 64) || 'unknown'
    await this.git(['commit', '-q', '-m', message, '--author', `${who} <${who}@ee.local>`])
    return (await this.head()) ?? ''
  }
}
