import type { ContributionStatus } from '../types'
import type { HubContribution, HubInstall, HubStore } from './store'
import type { HubProposalDto } from './types'
import { createHash, createPublicKey } from 'node:crypto'
import { z } from 'zod'
import { HUB_HEADERS, HUB_MAX_SKEW_MS, hubContributionV1, hubRegisterV1, verifyHubRequest } from '../share/contract'
import { HubError } from './errors'

/**
 * The central board (plan/contribute-phone-home.md §3). Installs register an
 * Ed25519 public key once (any install may), then every request is signed
 * (modules/contribute/share/contract.ts). Order of checks for a signed
 * request — nothing in the body is read before the signature holds:
 *   unknown install / bad or stale signature → 401; revoked → 403;
 *   signature seen before (replay) → 401; over the hourly limit → 429;
 *   then the strict body (an extra key → 400).
 */

/** Requests per install per hour (register included); the 61st is a 429. */
export const HUB_RATE_LIMIT_PER_HOUR = 60
const HOUR_MS = 60 * 60 * 1000

export type HubDeps = {
  store: HubStore
  /** Epoch ms (injected so specs move the clock). */
  now: () => number
}

/** A request as the route hands it over: the raw body, read once. */
export type HubRequest = { method: string; path: string; headers: Headers; body: string }

export type HubReply = { status: number; body: Record<string, unknown> }

const uuid = z.uuid()

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body)
  } catch {
    throw new HubError('invalid', 'expected a JSON body')
  }
}

function strict<T>(schema: z.ZodType<T>, body: string): T {
  const parsed = schema.safeParse(parseJson(body))
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw new HubError('invalid', `invalid body: ${issue?.path.join('.') || '(root)'}: ${issue?.message ?? 'does not match'}`)
  }
  return parsed.data
}

function isEd25519Spki(base64: string): boolean {
  try {
    return createPublicKey({ key: Buffer.from(base64, 'base64'), format: 'der', type: 'spki' }).asymmetricKeyType === 'ed25519'
  } catch {
    return false
  }
}

const hourOf = (ms: number) => new Date(Math.floor(ms / HOUR_MS) * HOUR_MS)

async function limit(deps: HubDeps, installId: string): Promise<void> {
  const n = await deps.store.countRequest(installId, hourOf(deps.now()))
  if (n > HUB_RATE_LIMIT_PER_HOUR) {
    throw new HubError('rate_limited', `more than ${HUB_RATE_LIMIT_PER_HOUR} requests this hour from this install; try again next hour`)
  }
}

/** POST /api/hub/register: 201 new, 200 the same id + key again; 409 another key for a known id; 403 revoked. */
export async function register(deps: HubDeps, body: string): Promise<HubReply> {
  const reg = strict(hubRegisterV1, body)
  if (!isEd25519Spki(reg.public_key)) throw new HubError('invalid', 'public_key is not an Ed25519 public key (SPKI DER, base64)')
  await limit(deps, reg.install_id)
  const at = new Date(deps.now())
  const answer = async (known: HubInstall): Promise<HubReply> => {
    if (known.revokedAt) throw new HubError('forbidden', 'this install was revoked by the central board')
    if (known.publicKey !== reg.public_key) throw new HubError('conflict', 'this install id is registered with another key')
    await deps.store.touchInstall(reg.install_id, at, reg.app_version)
    return { status: 200, body: { registered: true, install_id: reg.install_id } }
  }
  const known = await deps.store.getInstall(reg.install_id)
  if (known) return answer(known)
  if (await deps.store.insertInstall({ installId: reg.install_id, publicKey: reg.public_key, appVersion: reg.app_version, at })) {
    return { status: 201, body: { registered: true, install_id: reg.install_id } }
  }
  // Registered concurrently: answer as for a known install.
  const raced = await deps.store.getInstall(reg.install_id)
  if (!raced) throw new Error(`hub install ${reg.install_id} vanished during register`)
  return answer(raced)
}

/** The checks every signed request passes before its body is read; returns the install. */
async function authenticate(deps: HubDeps, req: HubRequest): Promise<HubInstall> {
  const installId = req.headers.get(HUB_HEADERS.install)
  if (!installId || !uuid.safeParse(installId).success) throw new HubError('unauthorized', `missing or malformed ${HUB_HEADERS.install} header`)
  const install = await deps.store.getInstall(installId)
  if (!install) throw new HubError('unauthorized', 'unknown install: register first')
  const now = deps.now()
  const verdict = verifyHubRequest({
    method: req.method,
    path: req.path,
    body: req.body,
    headers: {
      [HUB_HEADERS.install]: installId,
      [HUB_HEADERS.timestamp]: req.headers.get(HUB_HEADERS.timestamp) ?? undefined,
      [HUB_HEADERS.signature]: req.headers.get(HUB_HEADERS.signature) ?? undefined,
    },
    publicKey: install.publicKey,
    now,
  })
  if (!verdict.ok) throw new HubError('unauthorized', `request not accepted: ${verdict.reason}`)
  if (install.revokedAt) throw new HubError('forbidden', 'this install was revoked by the central board')
  const signature = req.headers.get(HUB_HEADERS.signature) as string
  const hash = createHash('sha256').update(signature).digest('hex')
  const at = new Date(now)
  if (!(await deps.store.claimSignature(hash, at, new Date(now - HUB_MAX_SKEW_MS)))) {
    throw new HubError('unauthorized', 'request not accepted: replay of a request already received')
  }
  await limit(deps, installId)
  await deps.store.touchInstall(installId, at)
  return install
}

function remote(id: string): string {
  if (!uuid.safeParse(id).success) throw new HubError('invalid', 'the id in the path is not a UUID')
  return id
}

function noBody(req: HubRequest): void {
  if (req.body !== '') throw new HubError('invalid', 'a DELETE carries no body')
}

/** PUT /api/hub/contributions/:remoteId — 201 created, 200 updated or unchanged. */
export async function upsertContribution(deps: HubDeps, req: HubRequest, remoteId: string): Promise<HubReply> {
  const install = await authenticate(deps, req)
  const p = strict(hubContributionV1, req.body)
  if (p.remote_id !== remoteId) throw new HubError('invalid', 'remote_id in the body is not the id in the path')
  const outcome = await deps.store.upsert(
    {
      installId: install.installId,
      remoteId: p.remote_id,
      summary: p.summary,
      language: p.language,
      kind: p.kind,
      area: p.area,
      status: p.status,
      score: p.score,
      appVersion: p.app_version,
      createdDay: p.created_day,
      shippedDay: p.shipped_day,
    },
    new Date(deps.now()),
  )
  return { status: outcome === 'created' ? 201 : 200, body: { outcome } }
}

/** DELETE /api/hub/contributions/:remoteId — withdraw one; 200 also when it was not there (idempotent). */
export async function deleteContribution(deps: HubDeps, req: HubRequest, remoteId: string): Promise<HubReply> {
  const install = await authenticate(deps, req)
  noBody(req)
  return { status: 200, body: { deleted: await deps.store.deleteContribution(install.installId, remote(remoteId)) } }
}

/** DELETE /api/hub/installs/:installId — the install withdraws everything it shared (only its own: 403 otherwise). */
export async function deleteInstall(deps: HubDeps, req: HubRequest, installId: string): Promise<HubReply> {
  const install = await authenticate(deps, req)
  noBody(req)
  if (installId !== install.installId) throw new HubError('forbidden', 'an install can only withdraw itself')
  return { status: 200, body: { deleted: await deps.store.deleteInstall(install.installId) } }
}

function toDto(r: HubContribution): HubProposalDto {
  return {
    installId: r.installId,
    remoteId: r.remoteId,
    summary: r.summary,
    language: r.language,
    kind: r.kind,
    area: r.area,
    status: r.status,
    score: r.score,
    appVersion: r.appVersion,
    createdDay: r.createdDay,
    shippedDay: r.shippedDay,
    updatedAt: r.updatedAt.toISOString(),
    receivedAt: r.receivedAt.toISOString(),
  }
}

/** The owner's read: every shared proposal in the statuses, highest score first. */
export async function listHubProposals(deps: HubDeps, statuses: readonly ContributionStatus[]): Promise<HubProposalDto[]> {
  return (await deps.store.list(statuses)).map(toDto)
}

export async function getHubProposal(deps: HubDeps, installId: string, remoteId: string): Promise<HubProposalDto> {
  if (!uuid.safeParse(installId).success || !uuid.safeParse(remoteId).success) throw new HubError('invalid', 'install_id and remote_id are UUIDs')
  const r = await deps.store.get(installId, remoteId)
  if (!r) throw new HubError('not_found', 'no such proposal on the central board')
  return toDto(r)
}

/** The owner refuses an install from now on (spam, abuse): its requests get 403. Its proposals stay until deleted. */
export async function revokeInstall(deps: HubDeps, installId: string): Promise<{ install_id: string; revoked_at: string }> {
  if (!uuid.safeParse(installId).success) throw new HubError('invalid', 'install_id is a UUID')
  const out = await deps.store.revokeInstall(installId, new Date(deps.now()))
  if (!out?.revokedAt) throw new HubError('not_found', 'no such install on the central board')
  return { install_id: out.installId, revoked_at: out.revokedAt.toISOString() }
}
