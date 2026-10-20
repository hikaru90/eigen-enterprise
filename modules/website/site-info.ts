import type { WebsitePage } from './store'

/** Where the website lives on this server: home at /s, pages at /s/<slug>. */
export const SITE_BASE_PATH = '/s'

export type SiteInfo = {
  url: string
  pages: { slug: string; title: string; status: 'published' | 'draft'; url: string }[]
}

/**
 * Normalize the configured console origin (env ORIGIN) to `scheme://host`.
 * Fails loud when unset — no implicit host.
 */
export function siteOrigin(raw: string | undefined): string {
  const trimmed = raw?.trim()
  if (!trimmed) throw new Error('ORIGIN is not set (required to build website URLs)')
  const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  return new URL(candidate).origin
}

export function sitePageUrl(origin: string, slug: string): string {
  return `${origin}${SITE_BASE_PATH}/${encodeURIComponent(slug)}`
}

export function buildSiteInfo(origin: string, pages: WebsitePage[]): SiteInfo {
  return {
    url: `${origin}${SITE_BASE_PATH}`,
    pages: pages.map((page) => ({
      slug: page.slug,
      title: page.title,
      status: page.visibility === 'public' ? 'published' : 'draft',
      url: sitePageUrl(origin, page.slug),
    })),
  }
}
