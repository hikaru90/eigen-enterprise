import { isProfileComplete, PROFILE_STEP_PATH, safeNextPath, type ProfileFields } from '$lib/profile/profile'

/**
 * The profile gate (P-5): a signed-in person without a complete profile
 * (first name, last name, picture) who opens any page of the app shell —
 * the `(nucleus)` route group, wherever sign-in (claim, signup, invite,
 * login) lands them — is sent to the profile step first, with the page they
 * wanted as `next`. Signed-out pages (login, signup, claim, invite — the
 * invite's passkey step comes first) and the step itself are never gated.
 * Harness accounts (automated verification) never see product surfaces.
 *
 * `request` is read lazily, only for people the gate may stop: SvelteKit
 * tracks which load inputs a load used, so the root layout load does not
 * re-run on every navigation for everyone with a complete profile.
 */

export const SHELL_ROUTE_GROUP = '/(nucleus)'

export type GateInput = {
  user: (ProfileFields & { id: string }) | null | undefined
  request: () => { routeId: string | null; path: string }
  isHarness: (userId: string) => Promise<boolean>
}

/** The URL to redirect to, or null to let the page load. */
export async function profileGateRedirect(input: GateInput): Promise<string | null> {
  const user = input.user
  if (!user || isProfileComplete(user)) return null
  const { routeId, path } = input.request()
  if (!routeId || !(routeId === SHELL_ROUTE_GROUP || routeId.startsWith(`${SHELL_ROUTE_GROUP}/`))) return null
  if (await input.isHarness(user.id)) return null
  return `${PROFILE_STEP_PATH}?next=${encodeURIComponent(safeNextPath(path))}`
}
