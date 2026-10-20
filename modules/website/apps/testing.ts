import type { AppsEe } from './tools'
import type { EeEvent, EeStatus, RepoContract } from '$lib/server/ee/client'

/** Test double for ee's control API (used by the tool and page specs). */

export const FAKE_REV = 'c'.repeat(40)

type Call = { verb: string; input: unknown }

/** ee in memory: records every call; a deploy goes live unless `failHealth`. */
export class FakeEe implements AppsEe {
  calls: Call[] = []
  repoContract: RepoContract = { present: false, contract: null, gap: null, error: null }
  failHealth = false
  workloads: EeStatus['workloads'] = []
  routes: EeStatus['routes'] = [{ host: 'os.ee.localhost', workload: 'os' }]
  journal: EeEvent[] = []
  secretNames: Record<string, string[]> = {}
  consoleHost = 'os.ee.localhost'

  async status(): Promise<EeStatus> {
    return {
      appliedRev: 'x',
      desiredRev: 'x',
      lastReconcileError: null,
      settings: { consoleHost: this.consoleHost, publicHost: null, acmeEmail: null },
      routes: this.routes,
      workloads: this.workloads.map((w) => ({ ...w, secrets: this.secretNames[w.name] ?? [] })),
      events: this.journal.slice(-50),
    }
  }
  async catalog() {
    return {
      runtimes: { node: ['22'], static: [] },
      services: ['postgres', 'kernel', 'files'],
      capabilities: [],
    }
  }
  async fetchSource(i: Parameters<AppsEe['fetchSource']>[0]) {
    this.calls.push({ verb: 'fetchSource', input: i })
    return { mirror: `sources/${i.name}.git`, ref: i.ref, rev: FAKE_REV }
  }
  async sourceContract(i: { name: string; rev: string }) {
    this.calls.push({ verb: 'sourceContract', input: i })
    return this.repoContract
  }
  async createApp(i: Parameters<AppsEe['createApp']>[0]) {
    this.calls.push({ verb: 'createApp', input: i })
    const release = `${i.source.rev.slice(0, 16)}${i.contract ? '-abcd1234' : ''}`
    const ev = (type: string, message: string): EeEvent => ({
      id: String(this.journal.length),
      time: '2026-10-20T10:00:00Z',
      type,
      workload: i.name,
      message,
      data: {},
    })
    this.journal.push(ev('deploy.started', 'starting'))
    this.workloads = [
      ...this.workloads.filter((w) => w.name !== i.name),
      {
        name: i.name,
        tier: 'app',
        source: i.source,
        deploy: i.deploy,
        contract: i.contract ?? null,
        secrets: [],
        declaredSecrets: i.secrets,
        live: this.failHealth ? null : { release, slot: 'a' },
        lastError: this.failHealth
          ? 'ee-shop-a.service did not pass its health check (GET /) in time\n<raw logs>'
          : null,
      },
    ]
    this.journal.push(
      this.failHealth ? ev('deploy.failed', 'health') : ev('deploy.succeeded', 'live'),
    )
    return {
      rev: 's1',
      reconcileError: this.failHealth ? 'reconcile finished with errors: <raw>' : null,
    }
  }
  async addDomain(i: Parameters<AppsEe['addDomain']>[0]) {
    this.calls.push({ verb: 'addDomain', input: i })
    this.routes = [...this.routes, { host: i.host, workload: i.workload }]
    return { rev: 's2', reconcileError: null }
  }
  async setSecret(i: Parameters<AppsEe['setSecret']>[0]) {
    this.calls.push({ verb: 'setSecret', input: i })
    this.secretNames[i.workload] = [...(this.secretNames[i.workload] ?? []), i.name]
    return { ok: true as const, reconcileError: null }
  }
  async events(workload: string) {
    return { workload, events: this.journal.filter((e) => e.workload === workload) }
  }
  async logs(workload: string) {
    return { workload, lines: ['listening on 4100'] }
  }
  async removeApp(i: { name: string; author: string }) {
    this.calls.push({ verb: 'removeApp', input: i })
    this.workloads = this.workloads.filter((w) => w.name !== i.name)
    return { rev: 's3', reconcileError: null }
  }
}
