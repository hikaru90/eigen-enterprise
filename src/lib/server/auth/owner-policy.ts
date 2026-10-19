/**
 * Single-tenant ownership (phase-0: one company per instance). The first human
 * to sign up is the owner (admin) by construction — no create-admin script.
 * On a server ee manages (a public box), signup then closes: a stranger who
 * finds the URL cannot create an account. Dev and test instances (not under
 * ee) keep open signup for fixtures.
 */
export class SignupClosedError extends Error {
  constructor() {
    super('This company already has an owner. Ask them to invite you.')
  }
}

export function ownerPolicyForNewUser(input: { existingUsers: number; managedByEe: boolean }): { role: 'admin' | 'user' } {
  if (input.existingUsers === 0) return { role: 'admin' }
  if (input.managedByEe) throw new SignupClosedError()
  return { role: 'user' }
}
