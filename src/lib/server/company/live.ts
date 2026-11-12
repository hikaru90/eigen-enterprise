import type { CompanyDeps } from './service'
import { companyLogoBlobs } from './logo'
import { companyProfileStore } from './store'

/** The live profile row and logo bytes (Settings → Company, the logo route). */
export function companyStorage(): Pick<CompanyDeps, 'store' | 'blobs'> {
  return { store: companyProfileStore(), blobs: companyLogoBlobs() }
}
