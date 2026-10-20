/**
 * Client calls behind the chat's approval surfaces: the Approve / Deny card
 * (POST /api/approvals/[id]) and the approval-mode dropdown
 * (GET/PUT /api/approvals/mode). Failures throw ApprovalRequestFailed; the
 * page shows its own fixed words, never the server's text.
 */

export type ApprovalDecision = 'approved' | 'denied'
export type ApprovalMode = 'ask' | 'reasonable' | 'allow_all'

export const APPROVAL_MODE_OPTIONS: ReadonlyArray<{ value: ApprovalMode; label: string }> = [
  { value: 'ask', label: 'Ask every time' },
  { value: 'reasonable', label: 'Make reasonable choices' },
  { value: 'allow_all', label: 'Allow everything' },
]

export type DecidedApproval = { id: string; toolName: string; status: ApprovalDecision }

export class ApprovalRequestFailed extends Error {
  readonly status: number
  constructor(what: string, status: number) {
    super(`${what} failed: HTTP ${status}`)
    this.name = 'ApprovalRequestFailed'
    this.status = status
  }
}

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>

const JSON_HEADERS = { 'content-type': 'application/json' }

export async function postApprovalDecision(
  fetchFn: FetchFn,
  approvalId: string,
  decision: ApprovalDecision,
): Promise<DecidedApproval> {
  const res = await fetchFn(`/api/approvals/${encodeURIComponent(approvalId)}`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ decision }),
  })
  if (!res.ok) throw new ApprovalRequestFailed('approval decision', res.status)
  return (await res.json()) as DecidedApproval
}

export function approvalModeFromResponse(body: unknown): ApprovalMode | null {
  if (typeof body !== 'object' || body === null) return null
  const mode = (body as { mode?: unknown }).mode
  return APPROVAL_MODE_OPTIONS.some((o) => o.value === mode) ? (mode as ApprovalMode) : null
}

export async function putApprovalMode(fetchFn: FetchFn, mode: ApprovalMode): Promise<ApprovalMode> {
  const res = await fetchFn('/api/approvals/mode', {
    method: 'PUT',
    headers: JSON_HEADERS,
    body: JSON.stringify({ mode }),
  })
  if (!res.ok) throw new ApprovalRequestFailed('approval mode update', res.status)
  const stored = approvalModeFromResponse(await res.json())
  if (!stored) throw new ApprovalRequestFailed('approval mode update (malformed reply)', res.status)
  return stored
}
