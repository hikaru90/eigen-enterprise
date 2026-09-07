import type { PageServerLoad } from './$types'
import { error } from '@sveltejs/kit'
import { isPubliclyRenderable } from '../../../../modules/website/render-gate'
import { defaultWebsiteStore } from '../../../../modules/website/store'

export const load: PageServerLoad = async (event) => {
  const slug = event.params.slug?.trim() ?? ''
  if (!slug) error(404, 'Page not found')

  const page = await defaultWebsiteStore().getPage(slug)
  if (!page || !isPubliclyRenderable(page)) error(404, 'Page not found')

  return {
    title: page.title,
    body: page.body,
    updatedAt: page.updatedAt,
  }
}
