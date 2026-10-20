import type { PageServerLoad } from './$types'
import { isUserAdmin } from '$lib/server/auth/user-role'
import { isPubliclyRenderable } from '../../../modules/website/render-gate'
import { defaultWebsiteStore } from '../../../modules/website/store'

/**
 * The website home: published pages for everyone; the signed-in admin owner
 * additionally sees drafts (flagged) so they can open the preview.
 */
export const load: PageServerLoad = async ({ locals }) => {
  const userId = locals.user?.id
  const owner = userId ? await isUserAdmin(userId) : false
  const pages = await defaultWebsiteStore().listPages({ kind: 'page' })
  return {
    pages: pages
      .filter((page) => owner || isPubliclyRenderable(page))
      .map((page) => ({
        slug: page.slug,
        title: page.title,
        draft: !isPubliclyRenderable(page),
      })),
  }
}
