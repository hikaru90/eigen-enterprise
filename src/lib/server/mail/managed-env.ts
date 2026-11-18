import { env } from '$lib/server/env/private-env'
import { readManagedMailConfig, type ManagedMailConfig } from './managed-config'

/** eigenEnterprise Mail's config from this process's EE_MAIL_* (null without it). Throws on a partial set. */
export function managedMailFromEnv(): ManagedMailConfig | null {
  return readManagedMailConfig(env as Record<string, string | undefined>)
}
