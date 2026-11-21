import type { Actions, PageServerLoad } from './$types'
import { fail } from '@sveltejs/kit'
import { isCroppableLogoType } from '$lib/company/identity'
import { requireCapability } from '$lib/server/auth/require-capability'
import { companyStorage } from '$lib/server/company/live'
import { checkLogo, cropLogo } from '$lib/server/company/logo'
import {
  readCompanyLogoOriginal,
  removeCompanyLogo,
  saveCompanyLogo,
  saveCompanyName,
} from '$lib/server/company/service'
import { companyProfileStore } from '$lib/server/company/store'
import { companyIdentity } from '$lib/server/overview/sources'
import { errorReport, refusalReport } from '$lib/server/errors/report'
import { ContributeError } from '../../../../../modules/contribute/errors'
import { setSharing, shareStatus } from '../../../../../modules/contribute/share/service'

/**
 * Settings → Company (Contribute `6a3b17ba`): the company's name and logo —
 * what the top left of the app shows, and the name every page uses (members,
 * invites, the "not a member" message, the unclaimed page, the installed
 * app). Owner and admins only; the person clicking is the decision. Brand
 * styles stay in Brand.
 *
 * A raster logo (PNG, JPEG, WebP) arrives with the crop the person chose
 * (Contribute `8c371cea`: zoom and position it in a square frame): the logo
 * stored is that crop, and the upload is kept as its original, so "Adjust"
 * can crop it again later. An SVG is kept as drawn.
 *
 * The owner also decides here whether proposals from the Contribute board are
 * shared with the eigenEnterprise makers (plan/contribute-phone-home.md §5):
 * on by default, the exact field list, and where sending stands.
 */

const REASON = 'Only the owner or an admin can change the company name and logo.'

/** The crop field as sent (JSON); undefined when it is missing or not JSON. cropLogo checks what it says. */
function parseCrop(raw: FormDataEntryValue | null): unknown {
  if (typeof raw !== 'string' || raw === '') return undefined
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return undefined
  }
}

type CompanyAction = 'saveName' | 'uploadLogo' | 'recropLogo' | 'setSharing'

const ATTEMPTED: Record<CompanyAction, string> = {
  saveName: 'Saving the company name in Settings → Company',
  uploadLogo: 'Uploading the company logo in Settings → Company',
  recropLogo: 'Cropping the company logo again in Settings → Company',
  setSharing:
    'Turning sharing of Contribute proposals with the makers on or off (Settings → Company)',
}

const WHERE: Record<CompanyAction, string> = {
  saveName: 'saveCompanyName (src/lib/server/company/service.ts)',
  uploadLogo: 'checkLogo / cropLogo (src/lib/server/company/logo.ts)',
  recropLogo: 'readCompanyLogoOriginal / cropLogo (src/lib/server/company/service.ts, logo.ts)',
  setSharing: 'setSharing (modules/contribute/share/service.ts)',
}

/** A refusal (not an exception): the person's sentence unchanged + the agent half. */
function refuse(status: number, action: CompanyAction, sentence: string, input?: unknown) {
  return fail(status, {
    action,
    ...refusalReport(sentence, {
      attempted: ATTEMPTED[action],
      ...(input !== undefined ? { input } : {}),
      nextSteps: [
        `${WHERE[action]} refused the request before anything was saved; the sentence says why.`,
      ],
    }),
  })
}

const shareDeps = async () =>
  (await import('../../../../../modules/contribute/share/live')).shareDeps()

export const load: PageServerLoad = async ({ locals }) => {
  const { role } = await requireCapability(locals, 'company.manage', REASON)
  const identity = await companyIdentity()
  return {
    company: {
      name: identity.name,
      logo: identity.logo
        ? {
            url: identity.logo.url,
            mime: identity.logo.mime,
            original: identity.logo.original
              ? { url: identity.logo.original.url, crop: identity.logo.original.crop }
              : null,
          }
        : null,
    },
    // Owner only: sharing proposals with the makers.
    share: role === 'owner' ? await shareStatus(await shareDeps()) : null,
  }
}

export const actions: Actions = {
  saveName: async ({ locals, request }) => {
    const { user } = await requireCapability(locals, 'company.manage', REASON)
    const form = await request.formData()
    const saved = await saveCompanyName(form.get('name'), user.id, { store: companyProfileStore() })
    if (!saved.ok) return refuse(400, 'saveName', saved.error, { name: form.get('name') })
    return { action: 'saveName', ok: true }
  },
  uploadLogo: async ({ locals, request }) => {
    const { user } = await requireCapability(locals, 'company.manage', REASON)
    const form = await request.formData()
    const file = form.get('logo')
    if (!(file instanceof File) || file.size === 0) {
      return refuse(400, 'uploadLogo', 'Choose an image file to upload.')
    }
    const check = await checkLogo(new Uint8Array(await file.arrayBuffer()), file.type)
    const fileInput = { name: file.name, type: file.type, size: file.size }
    if (!check.ok) return refuse(check.status, 'uploadLogo', check.error, { file: fileInput })
    if (!isCroppableLogoType(check.mime)) {
      await saveCompanyLogo({ bytes: check.bytes, mime: check.mime }, user.id, companyStorage())
      return { action: 'uploadLogo', ok: true }
    }
    const crop = parseCrop(form.get('crop'))
    if (crop === undefined)
      return refuse(400, 'uploadLogo', 'Position the logo in the frame, then save.', {
        file: fileInput,
      })
    const cut = await cropLogo(check.bytes, crop)
    if (!cut.ok) return refuse(cut.status, 'uploadLogo', cut.error, { file: fileInput, crop })
    await saveCompanyLogo(
      {
        bytes: cut.bytes,
        mime: cut.mime,
        original: { bytes: check.bytes, mime: check.mime, crop: cut.crop },
      },
      user.id,
      companyStorage(),
    )
    return { action: 'uploadLogo', ok: true }
  },
  recropLogo: async ({ locals, request }) => {
    const { user } = await requireCapability(locals, 'company.manage', REASON)
    const crop = parseCrop((await request.formData()).get('crop'))
    if (crop === undefined)
      return refuse(400, 'recropLogo', 'Position the logo in the frame, then save.')
    const storage = companyStorage()
    const original = await readCompanyLogoOriginal(storage)
    if (!original) {
      return refuse(
        400,
        'recropLogo',
        'This logo has no kept original to crop again; upload it again.',
        { crop },
      )
    }
    const cut = await cropLogo(original.bytes, crop)
    if (!cut.ok) return refuse(cut.status, 'recropLogo', cut.error, { crop })
    await saveCompanyLogo(
      { bytes: cut.bytes, mime: cut.mime, original: { ...original, crop: cut.crop } },
      user.id,
      storage,
    )
    return { action: 'recropLogo', ok: true }
  },
  setSharing: async ({ locals, request }) => {
    const { user, role } = await requireCapability(locals, 'company.manage', REASON)
    const form = await request.formData()
    const enabled = form.get('enabled')
    if (enabled !== 'on' && enabled !== 'off')
      return refuse(400, 'setSharing', 'Choose on or off.', { enabled })
    const input = { enabled: enabled === 'on', withdraw: form.get('withdraw') === 'on' }
    try {
      await setSharing(await shareDeps(), { id: user.id, isOwner: role === 'owner' }, input)
    } catch (err) {
      if (err instanceof ContributeError) {
        console.error('[settings/company] setSharing failed', err)
        return fail(err.code === 'forbidden' ? 403 : err.code === 'invalid' ? 400 : 502, {
          action: 'setSharing',
          ...errorReport(err, {
            attempted: ATTEMPTED.setSharing,
            input,
            plain: () => err.message,
            nextSteps: [
              `${WHERE.setSharing} failed with ContributeError code "${err.code}" (forbidden: not the owner; invalid: bad input; anything else: the central board did not answer as expected).`,
            ],
          }),
        })
      }
      throw err
    }
    return { action: 'setSharing', ok: true }
  },
  removeLogo: async ({ locals }) => {
    const { user } = await requireCapability(locals, 'company.manage', REASON)
    await removeCompanyLogo(user.id, companyStorage())
    return { action: 'removeLogo', ok: true }
  },
}
