import type { PageServerLoad } from './$types'
import { redirect } from '@sveltejs/kit'
import { getTextFile } from '$lib/server/text-files/service'

/**
 * Memory's documents are Drive files (wish f3fc516e, drizzle/0191): the
 * Documents tab is gone. Links already sent out (/m/memory/notes, ?note=<id>
 * with a Drive id or an old text-file id) land on the file in Drive.
 */
export const load: PageServerLoad = async (event) => {
  if (!event.locals.user) {
    throw redirect(302, '/login')
  }
  const note = event.url.searchParams.get('note')?.trim()
  const doc = note ? await getTextFile(event.locals.user.id, note) : null
  redirect(308, doc ? `/drive/file/${encodeURIComponent(doc.id)}` : '/drive')
}
