import { beforeEach, describe, expect, it, vi } from 'vitest'
import { KernelError } from '$lib/kernel/errors'
import type { PreviewView } from '$lib/server/ee/client'
import { AppBusyError, NO_EE_MESSAGE } from '../../../modules/drive/app-preview'
import { DriveError } from '../../../modules/drive/service'

const { execute, roleMock } = vi.hoisted(() => ({
  execute: vi.fn(),
  roleMock: vi.fn(async (): Promise<string | null> => 'admin'),
}))
vi.mock('$lib/server/boot', () => ({ appKernel: async () => ({ registry: { execute } }) }))
vi.mock('$lib/server/auth/user-role', () => ({ getUserRole: roleMock }))

const { driveAppTool } = await import('./drive-apps')

const signedIn = (id = 'u1') =>
  ({ locals: { user: { id } } }) as unknown as Parameters<typeof driveAppTool>[0]

describe('driveAppTool: the folder page’s app controls go through the registry', () => {
  beforeEach(() => vi.clearAllMocks())

  it('runs the tool as the signed-in person with their own kernel role', async () => {
    execute.mockResolvedValueOnce({ preview: { id: 'pv1' } })
    const res = await driveAppTool(signedIn(), 'drive.app_run', { folder_id: 'f1' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ preview: { id: 'pv1' } })
    expect(execute).toHaveBeenCalledWith(
      'drive.app_run',
      { folder_id: 'f1' },
      expect.objectContaining({ principal: { id: 'u1', kind: 'human', roles: ['admin'] } }),
    )
    roleMock.mockResolvedValueOnce('member')
    execute.mockResolvedValueOnce({})
    await driveAppTool(signedIn('m1'), 'drive.app_status', { folder_id: 'f1' })
    expect(execute).toHaveBeenLastCalledWith(
      'drive.app_status',
      { folder_id: 'f1' },
      expect.objectContaining({ principal: { id: 'm1', kind: 'human', roles: ['member'] } }),
    )
  })

  it('signed out → 401, the registry never runs', async () => {
    const res = await driveAppTool(
      { locals: { user: null } } as unknown as Parameters<typeof driveAppTool>[0],
      'drive.app_status',
      { folder_id: 'f1' },
    )
    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({
      error: 'Sign in to use Drive.',
      code: 'unauthorized',
      agent: { tool: 'drive.app_status' },
    })
    expect(execute).not.toHaveBeenCalled()
  })

  it('busy → 409 with the running preview; no ee → 503 with the plain sentence', async () => {
    const running = { id: 'pv000000000001', folderName: 'blog' } as PreviewView
    execute.mockRejectedValueOnce(new AppBusyError(running))
    const busy = await driveAppTool(signedIn(), 'drive.app_run', { folder_id: 'f1' })
    expect(busy.status).toBe(409)
    const busyBody = await busy.json()
    expect({ error: busyBody.error, code: busyBody.code, running: busyBody.running }).toEqual({
      error: 'Another app is running: blog',
      code: 'busy',
      running,
    })
    expect(busyBody.agent).toMatchObject({
      attempted: 'Running a Drive folder as an app preview',
      tool: 'drive.app_run',
      input: { folder_id: 'f1' },
      code: 'busy',
    })
    execute.mockRejectedValueOnce(new DriveError('unavailable', NO_EE_MESSAGE))
    const down = await driveAppTool(signedIn(), 'drive.app_run', { folder_id: 'f1' })
    expect(down.status).toBe(503)
    const downBody = await down.json()
    expect({ error: downBody.error, code: downBody.code }).toEqual({
      error: NO_EE_MESSAGE,
      code: 'unavailable',
    })
    expect(downBody.agent.code).toBe('unavailable')
  })

  it('a kernel refusal keeps its status, with a plain sentence for permission', async () => {
    execute.mockRejectedValueOnce(
      new KernelError('permission_denied', 'principal u1 lacks role admin for drive.app_run'),
    )
    const res = await driveAppTool(signedIn(), 'drive.app_run', { folder_id: 'f1' })
    expect(res.status).toBe(403)
    const body = await res.json()
    expect({ error: body.error, code: body.code }).toEqual({
      error: 'Only an owner or admin can run or stop apps in Drive.',
      code: 'permission_denied',
    })
    expect(body.agent).toMatchObject({
      tool: 'drive.app_run',
      code: 'permission_denied',
      cause: 'principal u1 lacks role admin for drive.app_run',
    })
  })

  it('anything else is a real failure (thrown, not dressed up)', async () => {
    execute.mockRejectedValueOnce(new Error('EE_STATE_DIR is not set'))
    await expect(driveAppTool(signedIn(), 'drive.app_run', { folder_id: 'f1' })).rejects.toThrow(
      /EE_STATE_DIR/,
    )
  })
})
