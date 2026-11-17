import type { BlobStore } from '../../../../modules/drive/storage'
import type { CompanyLogo, CompanyLogoOriginal, CompanyProfileStore } from './store'
import {
  companyLogoUrl,
  isLogoSha,
  normalizeCompanyName,
  type CompanyNameResult,
  type CroppableLogoType,
  type LogoType,
} from '$lib/company/identity'
import type { LogoCrop } from '$lib/company/logo-crop'

/**
 * The company's identity — the one source every page reads its name and logo
 * from (through companyIdentity / foundingCompanyName in
 * src/lib/server/overview/sources.ts): the shell, members and invites, the
 * "not a member" message, the unclaimed page, the installed app's name.
 *
 * The name is the one set in Settings → Company; until someone sets one
 * there it is the name the owner gave in the founding interview (where the
 * company was first named); null while neither has a name.
 */

export type CompanyDeps = {
  store: CompanyProfileStore
  blobs: BlobStore
  /** The founding interview's company name, null until given. */
  interviewName: () => Promise<string | null>
}

export type CompanyIdentity = {
  name: string | null
  /** `original` (with its own URL) when the logo was cropped from a kept original. */
  logo: (Omit<CompanyLogo, 'original'> & { url: string; original?: CompanyLogoOriginal & { url: string } }) | null
}

export async function resolveCompanyIdentity(deps: Pick<CompanyDeps, 'store' | 'interviewName'>): Promise<CompanyIdentity> {
  const profile = await deps.store.get()
  const name = profile?.name ?? (await deps.interviewName())
  const stored = profile?.logo
  if (!stored) return { name, logo: null }
  const { original, ...logo } = stored
  return {
    name,
    logo: {
      ...logo,
      url: companyLogoUrl(logo.sha256),
      ...(original ? { original: { ...original, url: companyLogoUrl(original.sha256) } } : {}),
    },
  }
}

export async function saveCompanyName(
  raw: unknown,
  by: string,
  deps: Pick<CompanyDeps, 'store'>,
): Promise<CompanyNameResult> {
  const checked = normalizeCompanyName(raw)
  if (checked.ok) await deps.store.setName(checked.name, by)
  return checked
}

const shasOf = (logo: CompanyLogo | null): string[] => (logo ? [logo.sha256, ...(logo.original ? [logo.original.sha256] : [])] : [])

/** Drops the replaced logo's bytes (and its original's) that the new one doesn't use. */
async function dropReplaced(previous: CompanyLogo | null, current: CompanyLogo | null, blobs: BlobStore): Promise<void> {
  const keep = new Set(shasOf(current))
  for (const sha of new Set(shasOf(previous))) if (!keep.has(sha)) await blobs.remove(sha)
}

/**
 * Stores checked logo bytes (checkLogo / cropLogo) and makes them the logo;
 * the replaced bytes go. A cropped logo also keeps the original it was cut
 * from and the crop, so it can be cropped again.
 */
export async function saveCompanyLogo(
  logo: { bytes: Uint8Array; mime: LogoType; original?: { bytes: Uint8Array; mime: CroppableLogoType; crop: LogoCrop } },
  by: string,
  deps: Pick<CompanyDeps, 'store' | 'blobs'>,
): Promise<CompanyLogo> {
  const { sha256 } = await deps.blobs.put(logo.bytes)
  const original = logo.original
    ? { sha256: (await deps.blobs.put(logo.original.bytes)).sha256, mime: logo.original.mime, crop: logo.original.crop }
    : undefined
  const saved: CompanyLogo = original ? { sha256, mime: logo.mime, original } : { sha256, mime: logo.mime }
  const { previous } = await deps.store.setLogo(saved, by)
  await dropReplaced(previous, saved, deps.blobs)
  return saved
}

export async function removeCompanyLogo(by: string, deps: Pick<CompanyDeps, 'store' | 'blobs'>): Promise<void> {
  const { previous } = await deps.store.setLogo(null, by)
  await dropReplaced(previous, null, deps.blobs)
}

/** The kept original of the current logo and its crop, or null when the logo was not cropped (or there is none). */
export async function readCompanyLogoOriginal(
  deps: Pick<CompanyDeps, 'store' | 'blobs'>,
): Promise<{ bytes: Uint8Array; mime: CroppableLogoType; crop: LogoCrop } | null> {
  const original = (await deps.store.get())?.logo?.original
  if (!original) return null
  if (!(await deps.blobs.has(original.sha256))) {
    throw new Error(`company logo original ${original.sha256} is kept for the current logo but missing on disk`)
  }
  return { bytes: await deps.blobs.get(original.sha256), mime: original.mime, crop: original.crop }
}

/** The current logo's (or its kept original's) bytes and type, or null (an old or unknown logo is not served). */
export async function readCompanyLogo(
  sha256: string,
  deps: Pick<CompanyDeps, 'store' | 'blobs'>,
): Promise<{ bytes: Uint8Array; mime: LogoType } | null> {
  if (!isLogoSha(sha256)) return null
  const logo = (await deps.store.get())?.logo
  const mime = logo?.sha256 === sha256 ? logo.mime : logo?.original?.sha256 === sha256 ? logo.original.mime : null
  if (!mime) return null
  if (!(await deps.blobs.has(sha256))) {
    throw new Error(`company logo ${sha256} is the current logo but missing on disk`)
  }
  return { bytes: await deps.blobs.get(sha256), mime }
}
