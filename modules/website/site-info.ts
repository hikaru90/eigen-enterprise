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

/**
 * Site URLs (plan/domains-one-claim.md): on the site's own host (ee's
 * publicHost) when it has one, else on the console. A draft is previewable
 * only by the signed-in owner, and the session lives on the console, so a
 * draft's link stays on the console either way.
 */
export function buildSiteInfo(
  origins: { console: string; site: string | null },
  pages: WebsitePage[],
): SiteInfo {
  const live = origins.site ?? origins.console
  return {
    url: `${live}${SITE_BASE_PATH}`,
    pages: pages.map((page) => {
      const published = page.visibility === 'public'
      return {
        slug: page.slug,
        title: page.title,
        status: published ? 'published' : 'draft',
        url: sitePageUrl(published ? live : origins.console, page.slug),
      }
    }),
  }
}
