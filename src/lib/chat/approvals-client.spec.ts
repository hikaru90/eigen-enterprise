import { describe, expect, it, vi } from 'vitest'
import {
  APPROVAL_MODE_OPTIONS,
  ApprovalRequestFailed,
  approvalModeFromResponse,
  postApprovalDecision,
  putApprovalMode,
} from './approvals-client'

function res(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response
}

describe('approval card decision (client)', () => {
  it('POSTs the decision for the card and returns the decided approval', async () => {
    const approval = { id: 'apr-1', toolName: 'repo.merge', status: 'approved' }
    const fetchFn = vi.fn(async () => res(200, approval))
    await expect(postApprovalDecision(fetchFn, 'apr-1', 'approved')).resolves.toEqual(approval)
    expect(fetchFn).toHaveBeenCalledWith('/api/approvals/apr-1', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'approved' }),
    })
  })

  it('fails loud on any non-2xx (the page shows its own words, never the server text)', async () => {
    const fetchFn = vi.fn(async () => res(409, { message: 'Approval request already denied' }))
    const err = await postApprovalDecision(fetchFn, 'apr-1', 'approved').catch((e) => e)
    expect(err).toBeInstanceOf(ApprovalRequestFailed)
    expect(err.status).toBe(409)
  })

  it('encodes the id into the path', async () => {
    const fetchFn = vi.fn(async () => res(200, {}))
    await postApprovalDecision(fetchFn, 'a/b', 'denied')
    expect(fetchFn.mock.calls[0][0]).toBe('/api/approvals/a%2Fb')
  })
})

describe('approval mode (client)', () => {
  it('offers the three modes in plain words', () => {
    expect(APPROVAL_MODE_OPTIONS).toEqual([
      { value: 'ask', label: 'Ask every time' },
      { value: 'reasonable', label: 'Make reasonable choices' },
      { value: 'allow_all', label: 'Allow everything' },
    ])
  })

  it('PUTs the mode and returns the stored mode', async () => {
    const fetchFn = vi.fn(async () => res(200, { mode: 'allow_all' }))
    await expect(putApprovalMode(fetchFn, 'allow_all')).resolves.toBe('allow_all')
    expect(fetchFn).toHaveBeenCalledWith('/api/approvals/mode', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'allow_all' }),
    })
  })

  it('rejects a failed or malformed PUT so the selection is not changed silently', async () => {
    await expect(putApprovalMode(vi.fn(async () => res(403, {})), 'ask')).rejects.toBeInstanceOf(
      ApprovalRequestFailed,
    )
    await expect(
      putApprovalMode(vi.fn(async () => res(200, { mode: 'nope' })), 'ask'),
    ).rejects.toBeInstanceOf(ApprovalRequestFailed)
  })

  it('parses only the contract shape', () => {
    expect(approvalModeFromResponse({ mode: 'reasonable' })).toBe('reasonable')
    expect(approvalModeFromResponse({ mode: 'x' })).toBeNull()
    expect(approvalModeFromResponse(null)).toBeNull()
  })
})
