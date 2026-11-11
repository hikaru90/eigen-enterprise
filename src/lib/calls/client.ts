import type { CallDto, CallTokenDto } from '../../../modules/calls/service'
import { problemFromResponse, type CallProblem } from './call-state'

/**
 * The browser's side of /api/calls (plan/video-calls.md §1 http). A refused
 * request throws CallRequestError carrying the problem decided by the
 * server's error code (e.g. not_configured → "Calls are not set up on this
 * server", shown as the server says it).
 */

export type { CallDto, CallTokenDto }
export type StartCall =
  | { contextKind: 'dm' | 'channel'; contextId: string }
  | { contextKind: 'meeting'; userIds: string[]; title?: string | null }

export class CallRequestError extends Error {
  constructor(readonly problem: CallProblem) {
    super(problem.message)
    this.name = 'CallRequestError'
  }
}

export type CallsClient = {
  start(input: StartCall): Promise<CallDto>
  get(id: string): Promise<CallDto>
  accept(id: string): Promise<CallDto>
  decline(id: string): Promise<CallDto>
  /** keepalive: still delivered while the page unloads (closing the tab mid-call). */
  hangup(id: string, opts?: { keepalive?: boolean }): Promise<CallDto>
  token(id: string): Promise<CallTokenDto>
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response
  try {
    res = await fetch(path, { ...init, headers: { 'content-type': 'application/json', ...(init.headers ?? {}) } })
  } catch (err) {
    throw new CallRequestError({ kind: 'failed', message: `could not reach the server (${err instanceof Error ? err.message : String(err)})` })
  }
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (!res.ok) throw new CallRequestError(problemFromResponse(res.status, body))
  return body as T
}

const at = (id: string) => `/api/calls/${encodeURIComponent(id)}`

const call = async (path: string, init?: RequestInit) => (await request<{ call: CallDto }>(path, init)).call

export function callsClient(): CallsClient {
  return {
    start: (input) => call('/api/calls', { method: 'POST', body: JSON.stringify(input) }),
    get: (id) => call(at(id)),
    accept: (id) => call(`${at(id)}/accept`, { method: 'POST' }),
    decline: (id) => call(`${at(id)}/decline`, { method: 'POST' }),
    hangup: (id, opts) => call(`${at(id)}/hangup`, { method: 'POST', keepalive: opts?.keepalive === true }),
    token: (id) => request<CallTokenDto>(`${at(id)}/token`),
  }
}

/** The error a person reads for any refused calls request. */
export const problemOf = (err: unknown): CallProblem =>
  err instanceof CallRequestError ? err.problem : { kind: 'failed', message: err instanceof Error ? err.message : String(err) }
