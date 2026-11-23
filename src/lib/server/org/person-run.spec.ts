import { beforeEach, describe, expect, it, vi } from 'vitest'
import { KernelError } from '$lib/kernel/errors'

const h = vi.hoisted(() => ({
  role: vi.fn(async (): Promise<string | null> => 'admin'),
  execute: vi.fn(),
  decide: vi.fn(async () => ({ kind: 'decided' })),
}))
vi.mock('$lib/server/auth/user-role', async () => {
  const roles = await import('$lib/server/auth/roles')
  return { getUserRole: h.role, isAdminRole: roles.isAdminRole, kernelRolesFor: roles.kernelRolesFor }
})
vi.mock('$lib/server/boot', () => ({ appKernel: async () => ({ registry: { execute: h.execute } }) }))
vi.mock('../../../../modules/index', () => ({ ensureSystemModulesActive: async () => undefined }))
vi.mock('$lib/server/approvals/owner-decision', () => ({ decideApprovalAsOwner: h.decide }))

import { kernelRolesFor } from '$lib/server/auth/roles'
import { isWaitingForApproval, NotAMemberError, personRun } from './person-run'

const waiting = () => new KernelError('approval_required', 'tool coworkers.create requires approval', { approvalId: 'ap1', tool: 'coworkers.create' })

beforeEach(() => {
  h.execute.mockReset()
  h.decide.mockClear()
})

describe('personRun (org chart and co-workers pages → the registry)', () => {
  it('runs the tool as the signed-in person with their real kernel roles', async () => {
    h.role.mockResolvedValue('member')
    h.execute.mockResolvedValue({ people: [] })
    expect(await personRun({ id: 'u1' }, 'org.chart', {})).toEqual({ people: [] })
    expect(h.execute).toHaveBeenCalledWith('org.chart', {}, expect.objectContaining({ principal: { id: 'u1', kind: 'human', roles: kernelRolesFor('member') } }))
  })

  it("an admin's click is their approval: the waiting request is approved as them and the tool runs", async () => {
    h.role.mockResolvedValue('admin')
    h.execute.mockRejectedValueOnce(waiting()).mockResolvedValueOnce({ id: 'cw1' })
    expect(await personRun({ id: 'a1' }, 'coworkers.create', { template_id: 'designer' })).toEqual({ id: 'cw1' })
    expect(h.decide).toHaveBeenCalledWith(expect.anything(), { id: 'a1' }, 'ap1', 'approved')
    expect(h.execute).toHaveBeenCalledTimes(2)
  })

  it("a member's change keeps waiting for an owner or admin (nothing is decided for them)", async () => {
    h.role.mockResolvedValue('member')
    h.execute.mockRejectedValue(waiting())
    const err = await personRun({ id: 'u1' }, 'org.set_position', { user_id: 'u1' }).catch((e: unknown) => e)
    expect(isWaitingForApproval(err)).toBe(true)
    expect(h.decide).not.toHaveBeenCalled()
  })

  it('other errors pass through unchanged', async () => {
    h.role.mockResolvedValue('admin')
    const refused = new KernelError('permission_denied', 'no')
    h.execute.mockRejectedValue(refused)
    await expect(personRun({ id: 'a1' }, 'coworkers.update', {})).rejects.toBe(refused)
    expect(h.decide).not.toHaveBeenCalled()
  })

  it('fails loud for someone who is not a member', async () => {
    h.role.mockResolvedValue(null)
    await expect(personRun({ id: 'x' }, 'org.chart', {})).rejects.toBeInstanceOf(NotAMemberError)
    expect(h.execute).not.toHaveBeenCalled()
  })
})
