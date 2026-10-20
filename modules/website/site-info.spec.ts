import { describe, expect, it } from 'vitest'
import { siteOrigin } from './site-info'
import { InMemoryWebsiteStore } from './store'
import { createWebsiteTools } from './tools'

const ctx = {
  principal: { id: 'p1', kind: 'agent' as const, roles: ['agent'] },
  requestId: 'r1',
}

describe('siteOrigin', () => {
  it('normalizes the configured console origin', () => {
    expect(siteOrigin('https://os.ee.localhost/')).toBe('https://os.ee.localhost')
    expect(siteOrigin('os.example.com')).toBe('https://os.example.com')
  })
  it('fails loud when no origin is configured', () => {
    expect(() => siteOrigin(undefined)).toThrow(/ORIGIN/)
    expect(() => siteOrigin('  ')).toThrow(/ORIGIN/)
  })
})

describe('website.site_info', () => {
  it('is a read tool returning absolute URLs for every page', async () => {
    const store = new InMemoryWebsiteStore()
    await store.createPage({ slug: 'home', title: 'Home', body: 'x', visibility: 'public' })
    await store.createPage({ slug: 'about', title: 'About', body: 'y' })
    const tool = createWebsiteTools({ store, origin: () => 'https://os.ee.localhost' }).find(
      (t) => t.name === 'website.site_info',
    )
    expect(tool?.auditClass).toBe('read')
    const result = (await tool!.handler(ctx, {})) as {
      url: string
      pages: { slug: string; title: string; status: string; url: string }[]
    }
    expect(result.url).toBe('https://os.ee.localhost/s')
    expect(result.pages.sort((a, b) => a.slug.localeCompare(b.slug))).toEqual([
      { slug: 'about', title: 'About', status: 'draft', url: 'https://os.ee.localhost/s/about' },
      { slug: 'home', title: 'Home', status: 'published', url: 'https://os.ee.localhost/s/home' },
    ])
  })

  it('url-encodes slugs', async () => {
    const store = new InMemoryWebsiteStore()
    await store.createPage({ slug: 'a b', title: 'T', body: 'x' })
    const tool = createWebsiteTools({ store, origin: () => 'https://h.test' }).find(
      (t) => t.name === 'website.site_info',
    )!
    const result = (await tool.handler(ctx, {})) as { pages: { url: string }[] }
    expect(result.pages[0]?.url).toBe('https://h.test/s/a%20b')
  })
})
