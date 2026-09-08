import type { WebsitePage } from './store'

/**
 * The /s/[slug] render gate: a page is publicly renderable only when its
 * visibility is exactly 'public'. Unknown slugs (null/undefined) never render.
 */
export function isPubliclyRenderable(
  page: Pick<WebsitePage, 'visibility'> | null | undefined,
): boolean {
  return page?.visibility === 'public'
}
