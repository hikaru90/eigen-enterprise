import { beforeEach, describe, expect, it, vi } from 'vitest'

const { roleMock } = vi.hoisted(() => ({
  roleMock: vi.fn(async (): Promise<string | null> => 'owner'),
}))
vi.mock('$lib/server/auth/user-role', () => ({ getUserRole: roleMock }))

import { KernelError } from '$lib/kernel/errors'
import type { CompanyExportView, ExportPort } from '$lib/kernel/export-tools'
import { _exportDeps, actions, load } from './+page.server'

const ID = '7c0b8f5e-3f1a-4b8e-9a51-0d6c1c2b3a4f'
const view: CompanyExportView = {
  id: ID,
  status: 'pending',
  requestedBy: 'u1',
  createdAt: '2026-11-23T12:00:00.000Z',
  finishedAt: null,
  expiresAt: null,
  bytes: null,
  summary: null,
  error: null,
  downloadPath: null,
}

function port(over: Partial<ExportPort> = {}): unknown[] {
  const calls: unknown[] = []
  const p: ExportPort = {
    isOwner: async () => true,
    start: async (userId) => {
      calls.push(['start', userId])
      return view
    },
    get: async () => view,
    list: async () => [view],
    remove: async (id) => {
      calls.push(['remove', id])
      return { ...view, status: 'deleted' }
    },
    ...over,
  }
  _exportDeps.port = async () => p
  return calls
}

const ev = (form?: Record<string, string>) =>
  ({
    locals: { user: { id: 'u1' } },
    request: new Request('http://x/settings/export', { method: 'POST', body: new URLSearchParams(form ?? {}) }),
  }) as never

beforeEach(() => {
  roleMock.mockResolvedValue('owner')
})

describe('Settings → Export', () => {
  it('lists the exports for the owner; an admin is refused', async () => {
    port()
    expect(await load(ev())).toEqual({ exports: [view] })
    roleMock.mockResolvedValue('admin')
    await expect(load(ev())).rejects.toMatchObject({ status: 403 })
  })

  it('starts an export as the owner', async () => {
    const calls = port()
    expect(await actions.start(ev())).toEqual({ action: 'start', ok: true, export: view })
    expect(calls).toEqual([['start', 'u1']])
  })

  it('a second export while one is built is refused with the reason', async () => {
    port({
      start: async () => {
        throw new KernelError('run_in_progress', 'A company export is already being built (x).')
      },
    })
    expect(await actions.start(ev())).toMatchObject({
      status: 409,
      data: { action: 'start', error: 'A company export is already being built (x).' },
    })
  })

  it('deletes one; an id that is no export is refused before the database is asked', async () => {
    const calls = port()
    expect(await actions.delete(ev({ id: ID }))).toEqual({ action: 'delete', ok: true })
    expect(await actions.delete(ev({ id: 'nope' }))).toMatchObject({ status: 404 })
    expect(calls).toEqual([['remove', ID]])
  })
})
