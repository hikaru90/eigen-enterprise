import { request } from 'node:http'

/** ee's AppContract (ee/src/spec.ts), as it travels over the control API. */
export type AppContract = {
  runtime: 'node' | 'static'
  node?: string
  build: string[][]
  start?: string[]
  preStart: string[][]
  staticDir?: string
  health: string
  portEnv?: string
  services: string[]
  capabilities: string[]
}

/** What eigen provides (ee's CATALOG, D16). */
export type Catalog = {
  runtimes: { node: string[]; static: string[] }
  services: string[]
  capabilities: string[]
}

/** ee's answer for the repo's own ee.json at a pinned rev. */
export type RepoContract = {
  present: boolean
  contract: AppContract | null
  /** Catalog entries the ee.json needs and eigen lacks. */
  gap: string[] | null
  error: string | null
}

/** ee's bounded listing of a mirror at a rev (GET /v1/sources/tree). */
export type SourceTree = {
  entries: Array<{ path: string; type: 'blob' | 'tree'; size: number | null }>
  truncated: boolean
}

/** One text file from a mirror at a rev (GET /v1/sources/file). */
export type SourceFile = { path: string; size: number; content: string }

/**
 * Client for ee's control API (ee/src/daemon.ts) over its unix socket. The
 * socket only exists on a box ee manages; anywhere else every call fails with
 * an explicit SubstrateUnavailableError — never a silent no-op.
 */

export const EE_CONTROL_SOCKET = '/run/ee/control/ee.sock'

export class SubstrateUnavailableError extends Error {
  readonly code = 'substrate_unavailable'
  constructor(detail: string) {
    super(`this eigenEnterprise is not running under ee (${EE_CONTROL_SOCKET}: ${detail})`)
  }
}

export class SubstrateError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** ee's problem type (e.g. urn:ee:catalog_gap) and body, for structured handling. */
    readonly type: string | null = null,
    readonly body: unknown = null,
  ) {
    super(message)
  }
}

export type EeTransport = (
  method: string,
  path: string,
  body?: unknown,
) => Promise<{ status: number; data: unknown }>

export const socketTransport =
  (socketPath = EE_CONTROL_SOCKET): EeTransport =>
  (method, path, body) => {
    const text = body === undefined ? '' : JSON.stringify(body)
    return new Promise((resolve, reject) => {
      const req = request(
        {
          socketPath,
          path,
          method,
          timeout: 15 * 60_000, // a deploy waits for the health gate
          headers: {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(text),
          },
        },
        (res) => {
          let raw = ''
          res.on('data', (d) => (raw += String(d)))
          res.on('end', () => {
            try {
              resolve({ status: res.statusCode ?? 500, data: raw ? JSON.parse(raw) : null })
            } catch {
              reject(new SubstrateError(502, `ee answered with non-JSON: ${raw.slice(0, 200)}`))
            }
          })
        },
      )
      req.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT' || err.code === 'ECONNREFUSED' || err.code === 'EACCES') {
          reject(new SubstrateUnavailableError(err.code))
        } else reject(err)
      })
      req.end(text)
    })
  }

export type EeStatus = {
  appliedRev: string | null
  desiredRev: string
  lastReconcileError: string | null
  settings: { consoleHost: string; publicHost: string | null; acmeEmail: string | null }
  routes: Array<{ host: string; workload: string; allowPaths?: string[] }>
  workloads: Array<{
    name: string
    tier: 'system' | 'module' | 'app'
    source: { kind: 'release' } | { kind: 'git'; mirror: string; ref: string; rev: string }
    deploy: { auto: boolean }
    /** The owner's build contract stored in the company repo (null: the repo's ee.json). */
    contract: AppContract | null
    secrets: string[]
    declaredSecrets: string[]
    live: { release: string; slot?: string } | null
    lastError: string | null
  }>
  events: Array<{
    id: string
    time: string
    type: string
    workload: string | null
    message: string
  }>
}

export type EeEvent = {
  id: string
  time: string
  type: string
  workload: string | null
  message: string
  data: Record<string, unknown>
}

export type EeDeployStage = 'fetching' | 'building' | 'starting' | 'health' | 'live' | 'failed'

/** ee's record of one deploy attempt (ee/src/deploys.ts). */
export type EeDeploy = {
  id: string
  workload: string
  release: string | null
  status: 'running' | 'live' | 'failed'
  stage: EeDeployStage
  stages: Array<{ stage: EeDeployStage; at: string }>
  startedAt: string
  endedAt: string | null
  /** The plain one-line cause ee recorded. */
  error: string | null
}

export type ChangeResult = { rev: string; reconcileError: string | null }

export class EeClient {
  constructor(private readonly transport: EeTransport = socketTransport()) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const { status, data } = await this.transport(method, path, body)
    if (status >= 400) {
      const problem = data as { detail?: string; type?: string } | null
      throw new SubstrateError(
        status,
        problem?.detail ?? `HTTP ${status}`,
        problem?.type ?? null,
        data,
      )
    }
    return data as T
  }

  status(): Promise<EeStatus> {
    return this.call('GET', '/v1/status')
  }
  addDomain(i: {
    host: string
    workload: string
    role: 'console' | 'public' | 'app'
    author: string
  }): Promise<ChangeResult> {
    return this.call('POST', '/v1/domains', i)
  }
  removeDomain(i: { host: string; author: string }): Promise<ChangeResult> {
    return this.call('DELETE', '/v1/domains', i)
  }
  /** https url (+ optional one-fetch token), or git@github.com:owner/repo.git + a deploy key ee holds. */
  fetchSource(i: {
    name: string
    url: string
    ref: string
    token?: string
    deployKeyId?: string
  }): Promise<{ mirror: string; ref: string; rev: string }> {
    return this.call('POST', '/v1/sources/fetch', i)
  }
  /** ee generates an ed25519 pair and keeps the private half sealed; only the public key comes back. */
  createDeployKey(i: {
    repo: string
    author: string
  }): Promise<{ keyId: string; publicKey: string }> {
    return this.call('POST', '/v1/deploy-keys', i)
  }
  /** Read-only `git ls-remote` over SSH with the key and GitHub's pinned host keys. */
  checkDeployKey(
    keyId: string,
    i: { repo: string },
  ): Promise<
    { ok: true; branches: string[] } | { ok: false; error: 'not_accepted'; detail: string }
  > {
    return this.call('POST', `/v1/deploy-keys/${encodeURIComponent(keyId)}/check`, i)
  }
  deleteDeployKey(keyId: string, i: { author: string }): Promise<{ ok: true }> {
    return this.call('DELETE', `/v1/deploy-keys/${encodeURIComponent(keyId)}`, i)
  }
  createApp(i: {
    name: string
    source: { kind: 'git'; mirror: string; ref: string; rev: string }
    env: Record<string, string>
    secrets: string[]
    deploy: { auto: boolean }
    /** The owner's contract when the repo has no ee.json (ee keeps it in the company repo). */
    contract?: AppContract
    author: string
  }): Promise<ChangeResult> {
    return this.call('POST', '/v1/apps', i)
  }
  /** What eigen provides (D16): runtimes, services, capabilities. */
  catalog(): Promise<Catalog> {
    return this.call('GET', '/v1/catalog')
  }
  /** The repo's own ee.json at a rev, read from ee's local mirror. */
  sourceContract(i: { name: string; rev: string }): Promise<RepoContract> {
    const q = new URLSearchParams({ name: i.name, rev: i.rev })
    return this.call('GET', `/v1/sources/contract?${q}`)
  }
  /** A bounded file list of the mirror at a rev (depth 1..4). */
  sourceTree(i: { name: string; rev: string; depth: number }): Promise<SourceTree> {
    const q = new URLSearchParams({ name: i.name, rev: i.rev, depth: String(i.depth) })
    return this.call('GET', `/v1/sources/tree?${q}`)
  }
  /** One text file (≤64KB) of the mirror at a rev; ee refuses paths outside the repo. */
  sourceFile(i: { name: string; rev: string; path: string }): Promise<SourceFile> {
    const q = new URLSearchParams({ name: i.name, rev: i.rev, path: i.path })
    return this.call('GET', `/v1/sources/file?${q}`)
  }
  /** One workload's journal events (deploy history), oldest first. */
  events(workload: string): Promise<{ workload: string; events: EeEvent[] }> {
    return this.call('GET', `/v1/events?${new URLSearchParams({ workload })}`)
  }
  /** The live slot's recent journal lines. 404 when nothing is live. */
  logs(workload: string): Promise<{ workload: string; lines: string[] }> {
    return this.call('GET', `/v1/logs?${new URLSearchParams({ workload })}`)
  }
  /** One workload's deploy attempts (stages, status, the plain cause), newest first. */
  deploys(workload: string): Promise<{ workload: string; deploys: EeDeploy[] }> {
    return this.call('GET', `/v1/deploys?${new URLSearchParams({ workload })}`)
  }
  /** One attempt's bounded, secret-redacted build + start log. */
  deployLog(id: string): Promise<{ deploy: EeDeploy; lines: string[] }> {
    return this.call('GET', `/v1/deploys/${encodeURIComponent(id)}/log`)
  }
  /** The repo's file names at a rev, from ee's local mirror. */
  sourceFiles(i: { name: string; rev: string }): Promise<{ files: string[]; truncated: boolean }> {
    return this.call(
      'GET',
      `/v1/sources/files?${new URLSearchParams({ name: i.name, rev: i.rev })}`,
    )
  }
  deploy(i: { workload: string; rev: string; author: string }): Promise<ChangeResult> {
    return this.call('POST', '/v1/deploy', i)
  }
  removeApp(i: { name: string; author: string }): Promise<ChangeResult> {
    return this.call('DELETE', '/v1/apps', i)
  }
  setSecret(i: {
    workload: string
    name: string
    value: string
    author: string
  }): Promise<{ ok: true; reconcileError: string | null }> {
    return this.call('POST', '/v1/secrets', i)
  }
}
