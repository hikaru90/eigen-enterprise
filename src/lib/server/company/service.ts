import type { BlobStore } from '../../../../modules/drive/storage'
import type { CompanyLogo, CompanyProfileStore } from './store'
import { companyLogoUrl, isLogoSha, normalizeCompanyName, type CompanyNameResult, type LogoType } from '$lib/company/identity'

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
  logo: (CompanyLogo & { url: string }) | null
}

export async function resolveCompanyIdentity(deps: Pick<CompanyDeps, 'store' | 'interviewName'>): Promise<CompanyIdentity> {
  const profile = await deps.store.get()
  const name = profile?.name ?? (await deps.interviewName())
  const logo = profile?.logo ? { ...profile.logo, url: companyLogoUrl(profile.logo.sha256) } : null
  return { name, logo }
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

/** Stores checked logo bytes (checkLogo) and makes them the logo; the replaced bytes go. */
export async function saveCompanyLogo(
  logo: { bytes: Uint8Array; mime: LogoType },
  by: string,
  deps: Pick<CompanyDeps, 'store' | 'blobs'>,
): Promise<CompanyLogo> {
  const { sha256 } = await deps.blobs.put(logo.bytes)
  const { previous } = await deps.store.setLogo({ sha256, mime: logo.mime }, by)
  if (previous && previous.sha256 !== sha256) await deps.blobs.remove(previous.sha256)
  return { sha256, mime: logo.mime }
}

export async function removeCompanyLogo(by: string, deps: Pick<CompanyDeps, 'store' | 'blobs'>): Promise<void> {
  const { previous } = await deps.store.setLogo(null, by)
  if (previous) await deps.blobs.remove(previous.sha256)
}

/** The current logo's bytes and type, or null (an old or unknown logo is not served). */
export async function readCompanyLogo(
  sha256: string,
  deps: Pick<CompanyDeps, 'store' | 'blobs'>,
): Promise<{ bytes: Uint8Array; mime: LogoType } | null> {
  if (!isLogoSha(sha256)) return null
  const logo = (await deps.store.get())?.logo
  if (!logo || logo.sha256 !== sha256) return null
  if (!(await deps.blobs.has(sha256))) {
    throw new Error(`company logo ${sha256} is the current logo but missing on disk`)
  }
  return { bytes: await deps.blobs.get(sha256), mime: logo.mime }
}
