import { identityTokens, type IdentityTokens } from '$lib/pwa/identity'
import { foundingCompanyName } from '$lib/server/overview/sources'
import { defaultBrandStore } from '../../../../modules/brand/store'

/** This instance's app identity: the company's name and its active brand. */
export async function loadIdentityTokens(): Promise<IdentityTokens> {
  const [name, visualSet] = await Promise.all([foundingCompanyName(), defaultBrandStore().findActiveVisualSet()])
  return identityTokens(name, visualSet?.cssVars ?? null)
}
