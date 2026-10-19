import { request } from 'node:http'

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
  ) {
    super(message)
  }
}

export type EeTransport = (method: string, path: string, body?: unknown) => Promise<{ status: number; data: unknown }>

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
          headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) },
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
    secrets: string[]
    declaredSecrets: string[]
    live: { release: string; slot?: string } | null
    lastError: string | null
  }>
  events: Array<{ id: string; time: string; type: string; workload: string | null; message: string }>
}

export type ChangeResult = { rev: string; reconcileError: string | null }

export class EeClient {
  constructor(private readonly transport: EeTransport = socketTransport()) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const { status, data } = await this.transport(method, path, body)
    if (status >= 400) {
      const detail = (data as { detail?: string; title?: string } | null)?.detail ?? `HTTP ${status}`
      throw new SubstrateError(status, detail)
    }
    return data as T
  }

  status(): Promise<EeStatus> {
    return this.call('GET', '/v1/status')
  }
  addDomain(i: { host: string; workload: string; role: 'console' | 'public' | 'app'; author: string }): Promise<ChangeResult> {
    return this.call('POST', '/v1/domains', i)
  }
  removeDomain(i: { host: string; author: string }): Promise<ChangeResult> {
    return this.call('DELETE', '/v1/domains', i)
  }
  fetchSource(i: { name: string; url: string; ref: string; token?: string }): Promise<{ mirror: string; ref: string; rev: string }> {
    return this.call('POST', '/v1/sources/fetch', i)
  }
  createApp(i: {
    name: string
    source: { kind: 'git'; mirror: string; ref: string; rev: string }
    env: Record<string, string>
    secrets: string[]
    deploy: { auto: boolean }
    author: string
  }): Promise<ChangeResult> {
    return this.call('POST', '/v1/apps', i)
  }
  deploy(i: { workload: string; rev: string; author: string }): Promise<ChangeResult> {
    return this.call('POST', '/v1/deploy', i)
  }
  removeApp(i: { name: string; author: string }): Promise<ChangeResult> {
    return this.call('DELETE', '/v1/apps', i)
  }
  setSecret(i: { workload: string; name: string; value: string; author: string }): Promise<{ ok: true; reconcileError: string | null }> {
    return this.call('POST', '/v1/secrets', i)
  }
}
