import type { LayoutServerLoad } from './$types'
import { error, redirect } from '@sveltejs/kit'
import { appKernel } from '$lib/server/boot'
import { CONTACTS_MODULE_ID } from '../../../../../../modules/contacts/manifest'

/**
 * Contacts inside the Email area (plan/contribute-round-3.md W1; moved from /m/contacts 2026-11-13). A system module: its
 * status comes from the same activation the kernel gates its tools on.
 */
export const load: LayoutServerLoad = async (event) => {
  if (!event.locals.user) throw redirect(302, '/login')
  const kernel = await appKernel()
  const manifest = kernel.modules.get(CONTACTS_MODULE_ID)
  if (!manifest) throw error(404, 'No such module')
  const active = (await kernel.activations.get(CONTACTS_MODULE_ID)) === true
  return { contactsModule: { name: manifest.name, active } }
}
