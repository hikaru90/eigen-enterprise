import type { SocialPost } from '../../../../../modules/brand/social/types'
import type { SocialApi } from './social-api'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page } from 'vitest/browser'
import { renderGraphicPng } from './social-export'
import SocialLibrary from './social-library.svelte'

describe('brand social: library', () => {
  const mounted: Array<() => void> = []
  afterEach(() => {
    for (const unmount of mounted.reverse()) unmount()
    mounted.length = 0
  })

  const style = { name: 'Blueprint', cssVars: { '--primary': 'rgb(255, 0, 0)' }, darkCssVars: null }

  function post(over: Partial<SocialPost> = {}): SocialPost {
    return {
      id: crypto.randomUUID(),
      title: 'Launch teaser',
      source: 'graphic',
      format: 'portrait',
      graphic: { headline: 'Something new', body: 'Next week.', cta: 'Stay tuned', mode: 'light' },
      networks: ['instagram', 'linkedin'],
      captions: { instagram: 'Soon on the feed' },
      status: 'draft',
      plannedFor: null,
      media: [],
      createdBy: 'orchestrator',
      createdByKind: 'agent',
      createdAt: '2026-11-18T10:00:00.000Z',
      updatedAt: '2026-11-18T10:00:00.000Z',
      ...over,
    }
  }

  function fakeApi(over: Partial<SocialApi> = {}): SocialApi {
    return {
      createGraphic: vi.fn(async (input) => post({ title: input.title, id: 'new-post' })),
      upload: vi.fn(),
      update: vi.fn(async (id, patch) => post({ id, ...(patch as Partial<SocialPost>) })),
      remove: vi.fn(async () => undefined),
      suggestCaptions: vi.fn(),
      ...over,
    } as SocialApi
  }

  function setup(props: Partial<Parameters<typeof render<typeof SocialLibrary>>[1]> = {}) {
    const r = render(SocialLibrary, {
      posts: [],
      style,
      activeLocales: [],
      assistantOn: true,
      api: fakeApi(),
      ...props,
    } as never)
    mounted.push(r.unmount)
    return r
  }

  it('empty: offers the assistant (a prefilled draft), a new graphic and an upload; says posting is not connected', async () => {
    setup()
    await expect.element(page.getByTestId('social-empty')).toBeVisible()
    const assistant = page.getByRole('link', { name: 'Create with assistant' })
    await expect.element(assistant).toHaveAttribute('href', expect.stringContaining('?prefill=Create%20a%20social%20media%20post'))
    await expect.element(page.getByRole('button', { name: 'New graphic' })).toBeEnabled()
    await expect.element(page.getByRole('button', { name: 'Upload a post' })).toBeVisible()
    await expect.element(page.getByTestId('social-not-connected')).toHaveTextContent('Posting to the networks isn’t connected yet.')
  })

  it('without the assistant there is no assistant button; without a style no new graphic', async () => {
    setup({ assistantOn: false, style: null })
    expect(document.querySelector('[data-testid="social-assistant"]')).toBeNull()
    await expect.element(page.getByRole('button', { name: 'New graphic' })).toBeDisabled()
    await expect.element(page.getByText('Graphics are drawn from your active style.')).toBeVisible()
  })

  it('lists posts with status and networks, filters by status, and draws graphics in the style', async () => {
    setup({
      posts: [
        post({ title: 'Teaser', status: 'draft' }),
        post({ title: 'Team day', source: 'upload', format: null, graphic: null, status: 'ready', networks: ['facebook'], media: [] }),
      ],
    })
    await expect.element(page.getByTestId('social-card').first()).toBeVisible()
    expect(document.querySelectorAll('[data-testid="social-card"]')).toHaveLength(2)
    const thumb = document.querySelector('[data-testid="social-thumb"]') as HTMLElement
    expect(thumb.style.aspectRatio).toBe('1080 / 1350')
    expect(getComputedStyle(thumb).getPropertyValue('--primary').trim()).toBe('rgb(255, 0, 0)')
    await page.getByRole('button', { name: 'Ready · 1' }).click()
    await expect.poll(() => document.querySelectorAll('[data-testid="social-card"]').length).toBe(1)
    await expect.element(page.getByTestId('social-card')).toHaveTextContent('Team day')
    await expect.element(page.getByTestId('social-card')).toHaveTextContent('Facebook')
  })

  it('opens a post: edits caption and status, saves through the api', async () => {
    const p = post()
    const api = fakeApi()
    setup({ posts: [p], api })
    await page.getByTestId('social-card').click()
    await expect.element(page.getByTestId('social-editor')).toBeVisible()
    await expect.element(page.getByLabelText('Instagram', { exact: true })).toHaveValue('Soon on the feed')
    await page.getByLabelText('LinkedIn', { exact: true }).fill('A word for LinkedIn')
    await page.getByRole('button', { name: 'Ready', exact: true }).click()
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect.element(page.getByRole('status')).toHaveTextContent('Saved')
    expect(api.update).toHaveBeenCalledWith(p.id, {
      title: 'Launch teaser',
      networks: ['instagram', 'linkedin'],
      captions: { instagram: 'Soon on the feed', linkedin: 'A word for LinkedIn' },
      status: 'ready',
      plannedFor: null,
      format: 'portrait',
      graphic: p.graphic,
    })
  })

  it('suggest captions: three variants per network, one click puts it in the caption', async () => {
    const p = post()
    const api = fakeApi({
      suggestCaptions: vi.fn(async () => ({
        postId: p.id,
        locale: 'en',
        voice: true,
        captions: { instagram: ['IG one', 'IG two', 'IG three'], linkedin: ['LI one', 'LI two', 'LI three'] },
      })),
    })
    setup({ posts: [p], api, selected: p.id })
    await page.getByLabelText('What should the captions say?').fill('mention Friday')
    await page.getByRole('button', { name: 'Suggest captions' }).click()
    await expect.element(page.getByTestId('caption-suggestions')).toBeVisible()
    expect(api.suggestCaptions).toHaveBeenCalledWith(p.id, { networks: ['instagram', 'linkedin'], brief: 'mention Friday' })
    expect(document.querySelectorAll('[data-testid="caption-suggestions"] li')).toHaveLength(6)
    await page.getByRole('listitem').filter({ hasText: 'LI two' }).getByRole('button', { name: 'Use' }).click()
    await expect.element(page.getByLabelText('LinkedIn', { exact: true })).toHaveValue('LI two')
  })

  it('suggest captions without an AI provider shows the server’s plain sentence', async () => {
    const p = post()
    const api = fakeApi({
      suggestCaptions: vi.fn(async () => {
        throw new Error('The company has no AI provider set up yet, so captions can’t be suggested.')
      }),
    })
    setup({ posts: [p], api, selected: p.id })
    await page.getByRole('button', { name: 'Suggest captions' }).click()
    await expect.element(page.getByRole('alert')).toHaveTextContent('no AI provider set up yet')
  })

  it('an uploaded carousel offers each file for download', async () => {
    const p = post({
      source: 'upload',
      format: null,
      graphic: null,
      media: [
        { id: 'm1', postId: 'x', position: 0, name: 'one.jpg', mime: 'image/jpeg', size: 3, sha256: 'a'.repeat(64) },
        { id: 'm2', postId: 'x', position: 1, name: 'two.jpg', mime: 'image/jpeg', size: 3, sha256: 'b'.repeat(64) },
      ],
    })
    setup({ posts: [p], selected: p.id })
    await expect.element(page.getByRole('link', { name: 'Download two.jpg' })).toHaveAttribute('href', '/api/brand/social/media/m2?download=1')
    await expect.element(page.getByRole('list', { name: 'Carousel' })).toBeVisible()
  })

  it('new graphic creates a draft and opens it', async () => {
    const api = fakeApi()
    setup({ api })
    await page.getByRole('button', { name: 'New graphic' }).click()
    await expect.element(page.getByTestId('social-editor')).toBeVisible()
    expect(api.createGraphic).toHaveBeenCalledWith(expect.objectContaining({ format: 'square', networks: ['instagram', 'linkedin'] }))
  })

  it('the graphic exports as a PNG at the post’s real size', async () => {
    const p = post({ format: 'square' })
    setup({ posts: [p], selected: p.id })
    await expect.element(page.getByTestId('social-graphic')).toBeVisible()
    const root = (document.querySelector('[data-testid="social-graphic"]') as HTMLElement).parentElement as HTMLElement
    const blob = await renderGraphicPng(root, { width: 1080, height: 1080 })
    expect(blob.type).toBe('image/png')
    const bitmap = await createImageBitmap(blob)
    expect([bitmap.width, bitmap.height]).toEqual([1080, 1080])
  })
})
