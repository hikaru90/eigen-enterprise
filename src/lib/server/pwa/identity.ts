import { identityTokens, type IdentityTokens } from '$lib/pwa/identity'
import { companyIdentity } from '$lib/server/overview/sources'
import { defaultBrandStore } from '../../../../modules/brand/store'

/** This instance's app identity: the company's name, its logo and its active brand. */
export async function loadIdentityTokens(): Promise<IdentityTokens> {
  const [company, visualSet] = await Promise.all([companyIdentity(), defaultBrandStore().findActiveVisualSet()])
  return identityTokens(company.name, visualSet?.cssVars ?? null, company.logo?.sha256 ?? null)
}
