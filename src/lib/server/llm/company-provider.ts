import { billingUserAsyncLocal } from '$lib/server/db/tenant-context'
import { LlmNotConfiguredError } from './errors'

/**
 * The company's AI provider is the one the owner set up (Settings → AI provider;
 * credentials are stored on the owner's account). A company-level feature any
 * member can trigger — the Contribute judge — runs its gateway calls on that
 * provider, not on the caller's own (usually empty) settings. Inside `fn` the
 * gateway resolves its provider config from the owner's account; usage and
 * activity stay attributed to the caller's `userId`.
 */

export type OwnerLookup = () => Promise<string | null>

const dbOwnerId: OwnerLookup = async () => {
  const { eq } = await import('drizzle-orm')
  const { authDb } = await import('$lib/server/db/auth-db')
  const { user } = await import('$lib/server/db/auth.schema')
  const [row] = await authDb.select({ id: user.id }).from(user).where(eq(user.role, 'owner')).limit(1)
  return row?.id ?? null
}

export async function onCompanyProvider<T>(fn: () => Promise<T>, ownerId: OwnerLookup = dbOwnerId): Promise<T> {
  const owner = await ownerId()
  if (!owner) {
    throw new LlmNotConfiguredError(
      "The company has no owner yet, so there is no company AI provider. The owner sets it up under Settings → AI provider.",
    )
  }
  return billingUserAsyncLocal.run(owner, fn)
}
