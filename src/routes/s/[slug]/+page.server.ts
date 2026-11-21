import type { Actions, PageServerLoad } from './$types'
import { error, fail, redirect } from '@sveltejs/kit'
import { KernelError } from '$lib/kernel/errors'
import { errorReport } from '$lib/server/errors/report'
import { isUserAdmin } from '$lib/server/auth/user-role'
import { defaultBrandStore } from '../../../../modules/brand/store'
import { grayscaleTint } from '../../../../modules/brand/style-format/tint'
import { isPubliclyRenderable } from '../../../../modules/website/render-gate'
import { defaultWebsiteStore } from '../../../../modules/website/store'

/**
 * The hero's look when NO visual set is active: the app's own current style —
 * an explicit in-repo constant (phase-2d V9: absence of a brand is legit, no
 * fallback machinery, values identical to the pre-M5 hardcoded hero).
 */
const HERO_BG = '#060606'
const HERO_FG = '#b9b9b9'
const HERO_H1_COLOR = '#ffffff'

export const load: PageServerLoad = async (event) => {
  const slug = event.params.slug?.trim() ?? ''
  if (!slug) error(404, 'Page not found')

  const page = await defaultWebsiteStore().getPage(slug)
  if (!page) error(404, 'Page not found')
  // Drafts/private pages: only the signed-in admin owner may preview them
  // (rendered with a draft banner); everyone else gets the same 404.
  const draft = !isPubliclyRenderable(page)
  const userId = event.locals.user?.id
  const admin = userId ? await isUserAdmin(userId) : false
  if (draft && !admin) error(404, 'Page not found')

  // Phase-2d M5 (V9): the active visual set drives the public hero; the
  // water-flow shader's monochrome invariant is a brand constant, so chromatic
  // tenant brands project onto the L axis (grayscaleTint) and keep the flow
  // live instead of tripping the static fallback. Null set = the constants
  // above, byte-identical to the pre-brand hero.
  const activeVisualSet = await defaultBrandStore().findActiveVisualSet()
  const heroBg = activeVisualSet?.cssVars['--background'] ?? HERO_BG
  const heroFg = activeVisualSet?.cssVars['--foreground'] ?? HERO_FG
  const h1Color = activeVisualSet?.cssVars['--foreground'] ?? HERO_H1_COLOR

  return {
    title: page.title,
    draft,
    body: page.body,
    updatedAt: page.updatedAt,
    /** The signed-in admin may delete the page (website.delete_page, as their own click). */
    canDelete: admin,
    brand: {
      heroBg,
      heroFg,
      h1Color,
      waterFlowFrom: grayscaleTint(heroBg),
      waterFlowTo: grayscaleTint(heroFg),
    },
  }
}

export const actions: Actions = {
  /**
   * The owner deletes this page for good. Runs website.delete_page through the
   * kernel as the signed-in human (audited); their click is their decision on
   * the tool's always-on approval (ownerRun).
   */
  deletePage: async (event) => {
    // Lazy: the public page's load never pulls in the kernel boot or auth stack.
    const { requireAdmin } = await import('$lib/server/auth/require-admin')
    const user = await requireAdmin(event.locals.user)
    const slug = event.params.slug?.trim() ?? ''
    try {
      const { ownerRun } = await import('$lib/server/website/owner-run')
      await ownerRun(user, 'website.delete_page', { slug })
    } catch (err) {
      console.error(
        `[website/page] delete ${slug} failed: ${err instanceof Error ? err.message : String(err)}`,
      )
      const denied = err instanceof KernelError && err.code === 'permission_denied'
      return fail(denied ? 403 : 400, {
        ...errorReport(err, {
          attempted: `Deleting the website page /s/${slug}`,
          tool: 'website.delete_page',
          input: { slug },
          plain: () =>
            denied
              ? 'Only an admin can delete a page.'
              : 'The page could not be deleted. Try again; if it keeps happening, ask in the chat.',
        }),
      })
    }
    redirect(303, '/s')
  },
}
