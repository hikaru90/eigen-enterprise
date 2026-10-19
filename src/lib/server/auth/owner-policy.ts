import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * Single-tenant ownership (phase-0: one company per instance).
 *
 * On a server ee manages (public), the first account is created ONLY through
 * the claim link the installer printed — holding it proves you installed the
 * server — and becomes the owner (admin). After that, signup is closed.
 * Dev and test instances (not under ee) keep open signup: first = owner.
 */
export class SignupClosedError extends Error {
  constructor() {
    super('This company already has an owner. Ask them to invite you.')
  }
}

export class UnclaimedServerError extends Error {
  constructor() {
    super('This server has not been claimed yet. Open the claim link the installer printed to become its owner.')
  }
}

/** Set while the claim flow creates the owner, so the user-create hook can tell it apart from signup. */
export const claimScope = new AsyncLocalStorage<true>()

export function ownerPolicyForNewUser(input: {
  existingUsers: number
  managedByEe: boolean
  viaClaim: boolean
}): { role: 'admin' | 'user' } {
  if (input.managedByEe) {
    if (input.existingUsers > 0) throw new SignupClosedError()
    if (!input.viaClaim) throw new UnclaimedServerError()
    return { role: 'admin' }
  }
  return { role: input.existingUsers === 0 ? 'admin' : 'user' }
}
