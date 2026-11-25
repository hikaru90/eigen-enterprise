import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The export endpoint over the real export path: the active style and the
 * company logo stubbed, the headless browser either missing (the real probe,
 * no EE_CAP_CHROMIUM) or a scripted renderer.
 */

const { state, render } = vi.hoisted(() => ({
  state: { style: null as unknown },
  render: { fake: null as null | ((html: string) => Promise<{ bytes: Uint8Array; mime: string }>), htmls: [] as string[] },
}))

vi.mock('../../../../../../modules/brand/store', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  defaultBrandStore: () => ({ findActiveVisualSet: async () => state.style }),
}))
vi.mock('$lib/server/brand/material', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  currentCompanyLogo: async () => ({ mime: 'image/png', bytes: new Uint8Array([1]) }),
}))
vi.mock('../../../../../../modules/brand/material/render', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../../../../modules/brand/material/render')>()
  return {
    ...original,
    renderMaterial: (html: string, ...rest: Parameters<typeof original.renderMaterial> extends [string, ...infer R] ? R : never) => {
      render.htmls.push(html)
      return render.fake ? render.fake(html) : original.renderMaterial(html, ...rest)
    },
  }
})

const { POST } = await import('./+server')

const style = {
  id: 's1',
  name: 'Blueprint',
  cssVars: {
    '--background': '#ffffff',
    '--foreground': '#111111',
    '--primary': '#b00000',
    '--primary-foreground': '#ffffff',
    '--accent': '#006600',
    '--muted-foreground': '#555555',
  },
  darkCssVars: null,
}

const call = (body: unknown, user: { id: string } | null = { id: 'ana' }) =>
  POST({
    locals: { user },
    request: new Request('http://x/', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
  } as never)

describe('POST /api/brand/material/export', () => {
  beforeEach(() => {
    vi.stubEnv('EE_CAP_CHROMIUM', '')
    state.style = style
    render.fake = null
    render.htmls = []
  })

  it('answers the print-ready file as a download, the logo on it', async () => {
    render.fake = async () => ({ bytes: new Uint8Array([37, 80, 68, 70]), mime: 'application/pdf' })
    const res = await call({ formatId: 'poster-a2', headline: 'Hall 3', body: 'Come by.', cta: 'Find us' })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/pdf')
    expect(res.headers.get('content-disposition')).toBe("attachment; filename*=UTF-8''hall-3-poster-a2.pdf")
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([37, 80, 68, 70]))
    expect(render.htmls[0]).toContain('data:image/png;base64,AQ==')
  })

  it('no headless browser on the server → 503 with the plain sentence', async () => {
    const res = await call({ formatId: 'flyer-a5', headline: 'Hi' })
    expect(res.status).toBe(503)
    await expect(res.json()).resolves.toMatchObject({ message: expect.stringMatching(/needs a browser on the server/) })
  })

  it('no active style → 404; a bad field → 400; signed out → 401', async () => {
    state.style = null
    expect((await call({ formatId: 'flyer-a5', headline: 'Hi' })).status).toBe(404)
    state.style = style
    expect((await call({ formatId: 'billboard', headline: 'Hi' })).status).toBe(400)
    await expect(call({ formatId: 'flyer-a5', headline: 'Hi' }, null)).rejects.toMatchObject({ status: 401 })
  })
})
