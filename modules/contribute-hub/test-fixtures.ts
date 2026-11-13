import type { HubDeps, HubRequest } from './service'
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { HUB_PATHS, signHubRequest, type HubContributionV1 } from '../contribute/share/contract'
import { memoryHubStore } from './memory-store'

/** One install's identity: a fresh Ed25519 keypair (SPKI / PKCS8 DER, base64) and a random id. */
export function testInstall() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  return {
    installId: randomUUID(),
    publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    privateKey: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
  }
}
export type TestInstall = ReturnType<typeof testInstall>

export const T0 = Date.parse('2026-11-13T10:00:00Z')

/** In-memory hub with a clock the spec moves. */
export function fixture() {
  const store = memoryHubStore()
  const clock = { now: T0 }
  const deps: HubDeps = { store, now: () => clock.now }
  return { store, clock, deps }
}

export const registerBody = (i: TestInstall, over: Record<string, unknown> = {}) =>
  JSON.stringify({ v: 1, install_id: i.installId, public_key: i.publicKey, app_version: '0.6.0', ...over })

export function payload(over: Partial<HubContributionV1> & Record<string, unknown> = {}): HubContributionV1 {
  return {
    v: 1,
    remote_id: randomUUID(),
    summary: 'Add a dark mode to the whole app',
    language: 'de',
    kind: 'idea',
    area: 'everywhere',
    status: 'requested',
    score: 2,
    app_version: '0.6.0',
    created_day: '2026-11-12',
    shipped_day: null,
    ...over,
  }
}

/** A request signed by `i` at `now` (the install's side of the contract). */
export function signed(i: TestInstall, method: string, path: string, body: string, now: number): HubRequest {
  const headers = new Headers(signHubRequest({ method, path, body, installId: i.installId, privateKey: i.privateKey, now }))
  headers.set('content-type', 'application/json')
  return { method, path, headers, body }
}

export const putReq = (i: TestInstall, p: HubContributionV1 | Record<string, unknown>, now: number, remoteId = String(p.remote_id)) =>
  signed(i, 'PUT', HUB_PATHS.contribution(remoteId), JSON.stringify(p), now)
