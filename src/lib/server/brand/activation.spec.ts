import { beforeEach, describe, expect, it, vi } from 'vitest'

const { executeMock, bootstrapMock } = vi.hoisted(() => ({
  executeMock: vi.fn(),
  bootstrapMock: vi.fn(),
}))

vi.mock('$lib/server/boot', async () => {
  const index = await import('../../../../modules/index')
  return { appKernel: async () => index.bootstrapKernel() }
})
vi.mock('../../../../modules/index', () => ({ bootstrapKernel: bootstrapMock }))

const { KernelError } = await import('$lib/kernel/errors')
const { brandModuleState, activateBrandModule } = await import('./activation')

const user = { id: 'owner-1' }

function kernelWith() {
  bootstrapMock.mockReturnValue({ registry: { execute: executeMock } })
}

describe('brand module activation surface', () => {
  beforeEach(() => {
    executeMock.mockReset()
    bootstrapMock.mockReset()
  })

  it('brandModuleState reports active when a brand read succeeds', async () => {
    kernelWith()
    executeMock.mockResolvedValueOnce([])
    await expect(brandModuleState(user)).resolves.toEqual({ active: true })
    expect(executeMock).toHaveBeenCalledWith('brand.set_list', {}, expect.anything())
  })

  it('brandModuleState reports inactive on module_inactive', async () => {
    kernelWith()
    executeMock.mockRejectedValueOnce(new KernelError('module_inactive', 'brand is not active'))
    await expect(brandModuleState(user)).resolves.toEqual({ active: false })
  })

  it('brandModuleState rethrows unrelated kernel errors', async () => {
    kernelWith()
    executeMock.mockRejectedValueOnce(new KernelError('permission_denied', 'nope'))
    await expect(brandModuleState(user)).rejects.toMatchObject({ code: 'permission_denied' })
  })

  it('activateBrandModule reports activated when the gate passes', async () => {
    kernelWith()
    executeMock.mockResolvedValueOnce({ module_id: 'brand', active: true })
    await expect(activateBrandModule(user)).resolves.toEqual({ activated: true })
    expect(executeMock).toHaveBeenCalledWith(
      'kernel.module_activate',
      { module_id: 'brand' },
      expect.objectContaining({ principal: { id: 'owner-1', kind: 'human', roles: ['admin'] } }),
    )
  })

  it('activateBrandModule maps approval_required to pendingApproval', async () => {
    kernelWith()
    executeMock.mockRejectedValueOnce(new KernelError('approval_required', 'owner must confirm'))
    await expect(activateBrandModule(user)).resolves.toEqual({ pendingApproval: true })
  })

  it('activateBrandModule rethrows unrelated kernel errors', async () => {
    kernelWith()
    executeMock.mockRejectedValueOnce(new KernelError('permission_denied', 'nope'))
    await expect(activateBrandModule(user)).rejects.toMatchObject({ code: 'permission_denied' })
  })
})
