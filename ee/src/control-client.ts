import { request } from 'node:http'
import { PATHS } from './paths.ts'

/** The ee daemon did not answer on its control socket (ee.service down or restarting). */
export class EeUnreachableError extends Error {}

export type Call = (method: string, path: string, body?: unknown) => Promise<{ status: number; data: unknown }>

/** One verb of the control API (daemon.ts) over its unix socket, as root or the ee-control group. */
export const callEe: Call = (method, path, body) => {
  const text = body === undefined ? '' : JSON.stringify(body)
  return new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath: PATHS.controlSocket,
        path,
        method,
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) },
      },
      (res) => {
        let raw = ''
        res.on('data', (d) => (raw += String(d)))
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode ?? 500, data: raw ? JSON.parse(raw) : null })
          } catch (err) {
            reject(new Error(`ee answered ${method} ${path} with something that is not JSON: ${raw.slice(0, 120)}`, { cause: err }))
          }
        })
      },
    )
    req.on('error', (err) =>
      reject(new EeUnreachableError(`ee daemon unreachable at ${PATHS.controlSocket} (is ee.service running?): ${err.message}`, { cause: err })),
    )
    req.end(text)
  })
}

/** The plain sentence of a refused call (the problem+json `title`). */
export function refusal(data: unknown, status: number): string {
  const d = data as { title?: unknown; detail?: unknown } | null
  return typeof d?.title === 'string' ? d.title : typeof d?.detail === 'string' ? d.detail : `ee answered ${status}`
}
