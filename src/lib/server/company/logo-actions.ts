import { isCroppableLogoType } from '$lib/company/identity'
import { checkLogo, cropLogo } from './logo'
import { readCompanyLogoOriginal, saveCompanyLogo, type CompanyDeps } from './service'

/**
 * The company logo's upload and re-crop as one effect for Settings → Company
 * (?/uploadLogo, ?/recropLogo) and the registry tools settings.logo_set /
 * settings.logo_recrop: the same checks (checkLogo: type, header, at most
 * 1 MB), the same crop (cropLogo) and the same store.
 */

export type LogoActionResult = { ok: true } | { ok: false; status: number; error: string }

type Storage = Pick<CompanyDeps, 'store' | 'blobs'>

/** A raster logo needs a crop (`undefined` = none sent); an SVG is kept as drawn. */
export async function uploadCompanyLogo(
  input: { bytes: Uint8Array; mime: string; crop: unknown },
  by: string,
  storage: Storage,
): Promise<LogoActionResult> {
  const check = await checkLogo(input.bytes, input.mime)
  if (!check.ok) return { ok: false, status: check.status, error: check.error }
  if (!isCroppableLogoType(check.mime)) {
    await saveCompanyLogo({ bytes: check.bytes, mime: check.mime }, by, storage)
    return { ok: true }
  }
  if (input.crop === undefined) return { ok: false, status: 400, error: 'Position the logo in the frame, then save.' }
  const cut = await cropLogo(check.bytes, input.crop)
  if (!cut.ok) return { ok: false, status: cut.status, error: cut.error }
  await saveCompanyLogo(
    { bytes: cut.bytes, mime: cut.mime, original: { bytes: check.bytes, mime: check.mime, crop: cut.crop } },
    by,
    storage,
  )
  return { ok: true }
}

/** Crops the kept original again; a logo without one (an SVG, or none) is refused. */
export async function recropCompanyLogo(crop: unknown, by: string, storage: Storage): Promise<LogoActionResult> {
  if (crop === undefined) return { ok: false, status: 400, error: 'Position the logo in the frame, then save.' }
  const original = await readCompanyLogoOriginal(storage)
  if (!original) {
    return { ok: false, status: 400, error: 'This logo has no kept original to crop again; upload it again.' }
  }
  const cut = await cropLogo(original.bytes, crop)
  if (!cut.ok) return { ok: false, status: cut.status, error: cut.error }
  await saveCompanyLogo({ bytes: cut.bytes, mime: cut.mime, original: { ...original, crop: cut.crop } }, by, storage)
  return { ok: true }
}
