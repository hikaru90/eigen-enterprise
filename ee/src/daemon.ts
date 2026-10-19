import { chmod, chown, rm } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { z } from 'zod'
import { CompanyRepo, type DesiredState } from './company-repo.ts'
import { loadJournal, saveJournal, type Journal } from './journal.ts'
import { CONTROL_GROUP, PATHS } from './paths.ts'
import { emit, reconcile } from './reconcile.ts'
import { SecretStore } from './secret-store.ts'
import { gitSource, NAME, routeSchema, workloadSchema, type Route, type Workload } from './spec.ts'
import { mustRun, type System } from './system.ts'
import { addDomain, removeDomain, setConsoleHost } from './domains.ts'
import { fetchSource } from './sources.ts'
import { claimUrl, newClaim } from './claim.ts'

/**
 * The control API (§3.1): typed verbs over a unix socket, readable only by root
 * and the ee-control group (granted to the os workload by the install template).
 * There is no "run this" verb; every mutation is validate → commit → reconcile.
 */

export class Ee {
  private queue: Promise<unknown> = Promise.resolve()
  readonly repo: CompanyRepo
  journal!: Journal
  lastReconcileError: string | null = null

  constructor(
    readonly sys: System,
    readonly secrets: SecretStore,
  ) {
    this.repo = new CompanyRepo(sys, PATHS.company)
  }

  async load(): Promise<void> {
    this.journal = await loadJournal(this.sys)
  }

  /** Serialize every mutation and reconcile; ee never runs two at once. */
  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn)
    this.queue = next.catch(() => undefined)
    return next
  }

  reconcile(): Promise<DesiredState> {
    return this.exclusive(async () => {
      try {
        const d = await reconcile({ sys: this.sys, repo: this.repo, journal: this.journal, secrets: this.secrets })
        this.lastReconcileError = null
        return d
      } catch (err) {
        this.lastReconcileError = err instanceof Error ? err.message : String(err)
        await saveJournal(this.sys, this.journal)
        throw err
      }
    })
  }

  /** Commit a desired-state change, then converge to it. */
  async change(
    message: string,
    author: string,
    mutate: Parameters<CompanyRepo['commit']>[2],
  ): Promise<{ rev: string; reconcileError: string | null }> {
    const rev = await this.exclusive(() => this.repo.commit(message, author, mutate))
    emit(this.journal, this.sys, 'state.committed', null, message, { rev, author })
    try {
      await this.reconcile()
      return { rev, reconcileError: null }
    } catch (err) {
      return { rev, reconcileError: err instanceof Error ? err.message : String(err) }
    }
  }

  async status() {
    const desired = await this.repo.read()
    return {
      appliedRev: this.journal.appliedRev,
      desiredRev: desired.rev,
      lastReconcileError: this.lastReconcileError,
      settings: desired.settings,
      routes: desired.routes,
      workloads: desired.workloads.map((w) => {
        const j = this.journal.workloads[w.name]
        const live = j?.active ? j.slots[j.active] : undefined
        return {
          name: w.name,
          tier: w.tier,
          source: w.source.kind === 'git' ? { kind: 'git', mirror: w.source.mirror, ref: w.source.ref, rev: w.source.rev } : { kind: 'release' },
          deploy: w.deploy,
          secrets: Object.keys(this.secrets.all()[w.name] ?? {}),
          declaredSecrets: w.secrets,
          live: live ? { release: live.release, slot: j?.active } : j?.staticRoot ? { release: 'static' } : null,
          lastError: j?.lastError ?? null,
        }
      }),
      events: this.journal.events.slice(-50),
    }
  }
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

async function body(req: IncomingMessage): Promise<unknown> {
  let raw = ''
  for await (const chunk of req) {
    raw += String(chunk)
    if (raw.length > 1_000_000) throw new HttpError(413, 'body too large')
  }
  if (raw === '') return {}
  try {
    return JSON.parse(raw)
  } catch {
    throw new HttpError(400, 'body is not JSON')
  }
}

function send(res: ServerResponse, status: number, data: unknown): void {
  const text = JSON.stringify(data)
  res.writeHead(status, { 'content-type': status >= 400 ? 'application/problem+json' : 'application/json' })
  res.end(text)
}

const author = z.string().min(1).max(64)
const domainInput = z.object({ host: routeSchema.shape.host, workload: z.string().regex(NAME), role: z.enum(['console', 'public', 'app']), author }).strict()
const secretInput = z.object({ workload: z.string().regex(/^[a-z_][a-z0-9_-]{1,30}$/), name: z.string().regex(/^[A-Z_][A-Z0-9_]*$/), value: z.string().min(1).max(16384), author }).strict()
const appInput = z
  .object({
    name: z.string().regex(NAME),
    source: gitSource,
    env: workloadSchema.shape.env,
    secrets: workloadSchema.shape.secrets,
    deploy: workloadSchema.shape.deploy,
    author,
  })
  .strict()
const deployInput = z.object({ workload: z.string().regex(NAME), rev: z.string().regex(/^[0-9a-f]{40}$/), author }).strict()
const fetchInput = z
  .object({
    name: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/),
    url: z.string().url().startsWith('https://'),
    ref: z.string().min(1).max(200),
    /** Short-lived token used for this fetch only; never persisted by ee. */
    token: z.string().min(1).max(4096).optional(),
  })
  .strict()

export function startControlServer(ee: Ee): Promise<void> {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://ee')
      const route = `${req.method} ${url.pathname}`
      if (route === 'GET /v1/status') return send(res, 200, await ee.status())
      if (route === 'POST /v1/reconcile') {
        try {
          await ee.reconcile()
          return send(res, 200, { ok: true })
        } catch (err) {
          return send(res, 500, { type: 'urn:ee:reconcile_failed', title: 'reconcile failed', detail: (err as Error).message })
        }
      }
      if (route === 'POST /v1/domains') {
        const i = domainInput.parse(await body(req))
        return send(res, 200, await ee.change(`domain: ${i.host} → ${i.workload} (${i.role})`, i.author, (s) => addDomain(s, i)))
      }
      if (route === 'DELETE /v1/domains') {
        const i = z.object({ host: z.string(), author }).strict().parse(await body(req))
        return send(res, 200, await ee.change(`domain: remove ${i.host}`, i.author, (s) => removeDomain(s, i.host)))
      }
      if (route === 'POST /v1/console-host') {
        const i = z.object({ host: routeSchema.shape.host, author }).strict().parse(await body(req))
        return send(res, 200, await ee.change(`console host: ${i.host}`, i.author, (s) => setConsoleHost(s, i.host)))
      }
      if (route === 'POST /v1/secrets') {
        const i = secretInput.parse(await body(req))
        if (i.workload.startsWith('_')) throw new HttpError(403, 'internal secret scopes are not settable')
        const desired = await ee.repo.read()
        const target = desired.workloads.find((w) => w.name === i.workload)
        if (!target) throw new HttpError(404, `no workload ${i.workload}`)
        await ee.exclusive(() => ee.secrets.set(i.workload, i.name, i.value))
        emit(ee.journal, ee.sys, 'secret.set', i.workload, `secret ${i.name} set by ${i.author}`)
        // Setting a secret declares it: the workload gets it on its next (health-gated) deploy.
        if (!target.secrets.includes(i.name)) {
          const r = await ee.change(`secret: ${i.workload} declares ${i.name}`, i.author, (s) => ({
            ...s,
            workloads: s.workloads.map((w) => (w.name === i.workload ? { ...w, secrets: [...w.secrets, i.name] } : w)),
          }))
          return send(res, 200, { ok: true, reconcileError: r.reconcileError })
        }
        try {
          await ee.reconcile()
          return send(res, 200, { ok: true, reconcileError: null })
        } catch (err) {
          return send(res, 200, { ok: true, reconcileError: (err as Error).message })
        }
      }
      if (route === 'POST /v1/claim') {
        // A fresh claim link (lost or expired). Only the hash + expiry are stored;
        // the token goes back once, to the caller (root on the box, via `ee claim-link`).
        const i = z.object({ author }).strict().parse(await body(req))
        const claim = newClaim()
        await ee.exclusive(async () => {
          await ee.secrets.set('os', 'EE_CLAIM_TOKEN_HASH', claim.hash)
          await ee.secrets.set('os', 'EE_CLAIM_EXPIRES_AT', claim.expiresAt)
        })
        emit(ee.journal, ee.sys, 'claim.issued', 'os', `new claim link issued by ${i.author} (expires ${claim.expiresAt})`)
        const desired = await ee.repo.read()
        let reconcileError: string | null = null
        try {
          await ee.reconcile()
        } catch (err) {
          reconcileError = (err as Error).message
        }
        return send(res, 200, { url: claimUrl(desired.settings.consoleHost, claim.token), expiresAt: claim.expiresAt, reconcileError })
      }
      if (route === 'POST /v1/sources/fetch') {
        const i = fetchInput.parse(await body(req))
        const rev = await ee.exclusive(() => fetchSource(ee.sys, i))
        return send(res, 200, { mirror: `sources/${i.name}.git`, ref: i.ref, rev })
      }
      if (route === 'POST /v1/apps') {
        const i = appInput.parse(await body(req))
        return send(
          res,
          200,
          await ee.change(`app: ${i.name} @ ${i.source.rev.slice(0, 12)}`, i.author, (s) => {
            const existing = s.workloads.find((w) => w.name === i.name)
            if (existing && existing.tier !== 'app') throw new HttpError(403, `${i.name} is a ${existing.tier} workload`)
            // Re-creating an app keeps the secrets it already declared (values live in the store).
            const secrets = [...new Set([...(existing?.secrets ?? []), ...i.secrets])]
            const next: Workload = workloadSchema.parse({ name: i.name, tier: 'app', source: i.source, env: i.env, secrets, deploy: i.deploy })
            return { ...s, workloads: [...s.workloads.filter((w) => w.name !== i.name), next] }
          }),
        )
      }
      if (route === 'POST /v1/deploy') {
        const i = deployInput.parse(await body(req))
        return send(
          res,
          200,
          await ee.change(`deploy: ${i.workload} @ ${i.rev.slice(0, 12)}`, i.author, (s) => ({
            ...s,
            workloads: s.workloads.map((w) => {
              if (w.name !== i.workload) return w
              if (w.source.kind !== 'git') throw new HttpError(409, `${w.name} is not a git workload`)
              return { ...w, source: { ...w.source, rev: i.rev } }
            }),
          })),
        )
      }
      if (route === 'DELETE /v1/apps') {
        const i = z.object({ name: z.string().regex(NAME), author }).strict().parse(await body(req))
        return send(
          res,
          200,
          await ee.change(`app: remove ${i.name}`, i.author, (s) => {
            const w = s.workloads.find((x) => x.name === i.name)
            if (!w) throw new HttpError(404, `no workload ${i.name}`)
            if (w.tier !== 'app') throw new HttpError(403, `${i.name} is a ${w.tier} workload`)
            return { ...s, workloads: s.workloads.filter((x) => x.name !== i.name), routes: s.routes.filter((r: Route) => r.workload !== i.name) }
          }),
        )
      }
      if (route === 'GET /v1/logs') {
        const name = z.string().regex(NAME).parse(url.searchParams.get('workload'))
        const j = ee.journal.workloads[name]
        if (!j?.active) throw new HttpError(404, `${name} has nothing live`)
        const out = await mustRun(ee.sys, 'journalctl', ['-u', `ee-${name}-${j.active}.service`, '-n', '200', '--no-pager', '-o', 'short-iso'])
        return send(res, 200, { workload: name, lines: out.split('\n') })
      }
      throw new HttpError(404, `no such verb: ${route}`)
    } catch (err) {
      if (err instanceof z.ZodError) return send(res, 400, { type: 'urn:ee:invalid_input', title: 'invalid input', detail: err.message })
      if (err instanceof HttpError) return send(res, err.status, { type: 'urn:ee:error', title: err.message, detail: err.message })
      return send(res, 500, { type: 'urn:ee:internal', title: 'internal error', detail: (err as Error).message })
    }
  })

  return (async () => {
    await ee.sys.mkdirp(PATHS.controlSocketDir, 0o750)
    await rm(PATHS.controlSocket, { force: true })
    await new Promise<void>((resolve) => server.listen(PATHS.controlSocket, resolve))
    const gid = Number((await mustRun(ee.sys, 'getent', ['group', CONTROL_GROUP])).split(':')[2])
    await chown(PATHS.controlSocketDir, 0, gid)
    await chown(PATHS.controlSocket, 0, gid)
    await chmod(PATHS.controlSocketDir, 0o750)
    await chmod(PATHS.controlSocket, 0o660)
  })()
}
