import { beforeEach, describe, expect, it, vi } from 'vitest'
import { KernelError } from '$lib/kernel/errors'

const { executeMock, ownerRunMock, roleMock } = vi.hoisted(() => ({
  executeMock: vi.fn(),
  ownerRunMock: vi.fn(),
  roleMock: vi.fn(),
}))

vi.mock('$lib/server/boot', () => ({ appKernel: async () => ({ registry: { execute: executeMock } }) }))
vi.mock('$lib/server/website/owner-run', () => ({ ownerRun: ownerRunMock }))
vi.mock('$lib/server/auth/user-role', async (actual) => ({
  ...(await actual<typeof import('$lib/server/auth/roles')>()),
  getUserRole: roleMock,
}))

import { loadMemberAiCap, setMemberAiCapAction } from './member-ai-cap-page'

const USAGE = {
  role: 'member',
  capUsd: 1,
  capApplies: true,
  spentUsd: 0.25,
  remainingUsd: 0.75,
  resetsAt: '2026-11-24T00:00:00.000Z',
}

function formEvent(userId: string | null, fields: Record<string, string>) {
  const body = new FormData()
  for (const [k, v] of Object.entries(fields)) body.set(k, v)
  return {
    locals: { user: userId ? { id: userId } : null },
    request: new Request('http://x/settings/llm?/setMemberAiCap', { method: 'POST', body }),
  } as never
}

describe('Settings › AI provider: daily AI cap per member (a client of the registry tools)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    executeMock.mockResolvedValue(USAGE)
    ownerRunMock.mockImplementation(async (_user, _tool, input: { cap_usd: number | null }) => ({ capUsd: input.cap_usd }))
  })

  it('loads the person’s own usage today through settings.my_ai_usage, as that person', async () => {
    roleMock.mockResolvedValue('member')
    expect(await loadMemberAiCap('u-mia')).toEqual({ usage: USAGE })
    const [tool, input, ctx] = executeMock.mock.calls[0]!
    expect(tool).toBe('settings.my_ai_usage')
    expect(input).toEqual({})
    expect(ctx.principal).toEqual({ id: 'u-mia', kind: 'human', roles: ['member'] })
  })

  it('an admin sets the cap through settings.member_ai_cap_set; an empty field removes it', async () => {
    roleMock.mockResolvedValue('admin')
    expect(await setMemberAiCapAction(formEvent('u-ali', { capUsd: '0.50' }))).toEqual({
      capMessage: 'Saved: members can use up to $0.50 of AI per day.',
    })
    expect(ownerRunMock).toHaveBeenCalledWith({ id: 'u-ali' }, 'settings.member_ai_cap_set', { cap_usd: 0.5 })

    expect(await setMemberAiCapAction(formEvent('u-ali', { capUsd: '  ' }))).toEqual({
      capMessage: 'Saved: no daily AI cap for members.',
    })
    expect(ownerRunMock).toHaveBeenLastCalledWith({ id: 'u-ali' }, 'settings.member_ai_cap_set', { cap_usd: null })
  })

  it('a member is refused before the registry is asked', async () => {
    roleMock.mockResolvedValue('member')
    const out = await setMemberAiCapAction(formEvent('u-mia', { capUsd: '100' }))
    expect(out).toMatchObject({ status: 403 })
    expect(ownerRunMock).not.toHaveBeenCalled()
  })

  it('text, zero or a negative amount is a plain 400, never saved', async () => {
    roleMock.mockResolvedValue('owner')
    for (const capUsd of ['abc', '0', '-2']) {
      expect(await setMemberAiCapAction(formEvent('u-ada', { capUsd }))).toMatchObject({ status: 400 })
    }
    expect(ownerRunMock).not.toHaveBeenCalled()
  })

  it('what the tool refuses as invalid input is shown, not thrown', async () => {
    roleMock.mockResolvedValue('owner')
    ownerRunMock.mockRejectedValue(new KernelError('invalid_input', 'cap_usd: too big'))
    expect(await setMemberAiCapAction(formEvent('u-ada', { capUsd: '5' }))).toMatchObject({ status: 400 })
  })
})
