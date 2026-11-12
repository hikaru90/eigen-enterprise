import type { PluginGateDeps } from './gate'
import type { RequestEvent } from '@sveltejs/kit'
import { describe, expect, it, vi } from 'vitest'
import { pluginHandle } from './handle'

const deps = (active: Record<string, boolean>): PluginGateDeps => ({
  activations: async () => new Map(Object.entries(active)),
  pluginName: async (id) => ({ drive: 'Drive' })[id],
  canManage: async () => false,
  log: () => {},
})

function event(path: string, init: RequestInit = {}, userId: string | null = 'u1') {
  const url = new URL(`https://os.example.com${path}`)
  return {
    url,
    request: new Request(url, { headers: { accept: 'text/html' }, ...init }),
    isDataRequest: false,
    locals: userId ? { user: { id: userId } } : {},
  } as unknown as RequestEvent
}

describe('pluginHandle (the hooks.server.ts step)', () => {
  it('resolves a page of a switched-off plugin with locals.pluginOff for the layout to render', async () => {
    const e = event('/drive')
    const resolve = vi.fn(async () => new Response('page'))
    const res = await pluginHandle(deps({ drive: false }))({ event: e, resolve })
    expect(await res.text()).toBe('page')
    expect(resolve).toHaveBeenCalledOnce()
    expect(e.locals.pluginOff).toEqual({ id: 'drive', name: 'Drive', canManage: false })
  })

  it('answers an API of a switched-off plugin itself: the route never runs', async () => {
    const resolve = vi.fn(async () => new Response('route'))
    const res = await pluginHandle(deps({ drive: false }))({
      event: event('/api/drive/upload', { method: 'POST', headers: { accept: 'application/json' } }),
      resolve,
    })
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ code: 'plugin_inactive', plugin: 'drive' })
    expect(resolve).not.toHaveBeenCalled()
  })

  it('leaves everything alone while the plugin is on', async () => {
    const e = event('/drive')
    const resolve = vi.fn(async () => new Response('page'))
    await pluginHandle(deps({ drive: true }))({ event: e, resolve })
    expect(resolve).toHaveBeenCalledOnce()
    expect(e.locals.pluginOff).toBeUndefined()
  })
})
