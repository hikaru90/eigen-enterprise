import type { RegistrantDefaults } from '$lib/domains/registrant-defaults'
import { splitDisplayName } from '$lib/server/auth-user-name'
import { foundingCompanyName } from '$lib/server/overview/sources'

/**
 * What os already knows for the registrant form (plan/managed-domains.md: the
 * registrant is the company): its name, and the person buying as the contact.
 * Address and phone aren't stored anywhere in os, so the person types them.
 */
export async function registrantDefaults(user: {
  email: string
  name?: string | null
  firstName?: string | null
  lastName?: string | null
}): Promise<RegistrantDefaults> {
  const split = splitDisplayName(user.name ?? '')
  return {
    firstName: user.firstName?.trim() || split.firstName || '',
    lastName: user.lastName?.trim() || split.lastName || '',
    organization: (await foundingCompanyName()) ?? '',
    email: user.email,
  }
}
