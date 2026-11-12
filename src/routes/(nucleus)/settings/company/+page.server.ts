import type { Actions, PageServerLoad } from './$types'
import { fail } from '@sveltejs/kit'
import { requireCapability } from '$lib/server/auth/require-capability'
import { companyStorage } from '$lib/server/company/live'
import { checkLogo } from '$lib/server/company/logo'
import { removeCompanyLogo, saveCompanyLogo, saveCompanyName } from '$lib/server/company/service'
import { companyProfileStore } from '$lib/server/company/store'
import { companyIdentity } from '$lib/server/overview/sources'

/**
 * Settings → Company (Contribute `6a3b17ba`): the company's name and logo —
 * what the top left of the app shows, and the name every page uses (members,
 * invites, the "not a member" message, the unclaimed page, the installed
 * app). Owner and admins only; the person clicking is the decision. Brand
 * styles stay in Brand.
 */

const REASON = 'Only the owner or an admin can change the company name and logo.'

export const load: PageServerLoad = async ({ locals }) => {
  await requireCapability(locals, 'company.manage', REASON)
  const identity = await companyIdentity()
  return {
    company: {
      name: identity.name,
      logo: identity.logo ? { url: identity.logo.url, mime: identity.logo.mime } : null,
    },
  }
}

export const actions: Actions = {
  saveName: async ({ locals, request }) => {
    const { user } = await requireCapability(locals, 'company.manage', REASON)
    const form = await request.formData()
    const saved = await saveCompanyName(form.get('name'), user.id, { store: companyProfileStore() })
    if (!saved.ok) return fail(400, { action: 'saveName', error: saved.error })
    return { action: 'saveName', ok: true }
  },
  uploadLogo: async ({ locals, request }) => {
    const { user } = await requireCapability(locals, 'company.manage', REASON)
    const file = (await request.formData()).get('logo')
    if (!(file instanceof File) || file.size === 0) {
      return fail(400, { action: 'uploadLogo', error: 'Choose an image file to upload.' })
    }
    const check = await checkLogo(new Uint8Array(await file.arrayBuffer()), file.type)
    if (!check.ok) return fail(check.status, { action: 'uploadLogo', error: check.error })
    await saveCompanyLogo({ bytes: check.bytes, mime: check.mime }, user.id, companyStorage())
    return { action: 'uploadLogo', ok: true }
  },
  removeLogo: async ({ locals }) => {
    const { user } = await requireCapability(locals, 'company.manage', REASON)
    await removeCompanyLogo(user.id, companyStorage())
    return { action: 'removeLogo', ok: true }
  },
}
