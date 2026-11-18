import { env } from '$lib/server/env/private-env'
import { readDomainsConfig, type DomainsConfig } from './config'

/** The domains API config from this process's EE_DOMAINS_* (null without it). Throws on a partial set. */
export function domainsFromEnv(): DomainsConfig | null {
  return readDomainsConfig(env as Record<string, string | undefined>)
}
