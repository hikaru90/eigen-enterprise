import type { Principal, PrincipalStore } from '$lib/kernel/principals'

/** CLI principal resolution: explicit --principal flag wins, else the env var. No fallbacks. */

export const PRINCIPAL_FLAG = '--principal'
export const PRINCIPAL_ENV_VAR = 'EE_CLI_PRINCIPAL_ID'

export class CliPrincipalError extends Error {}

export function principalFlagValue(flags: Record<string, string | boolean>): string | undefined {
  const value = flags.principal
  return typeof value === 'string' ? value : undefined
}

export async function resolveCliPrincipal(params: {
  flagValue: string | undefined
  env: Record<string, string | undefined>
  principals: PrincipalStore
}): Promise<Principal> {
  const flag = params.flagValue
  if (flag !== undefined && flag.length === 0) {
    throw new CliPrincipalError(`${PRINCIPAL_FLAG} requires a non-empty principal id`)
  }
  const id = flag ?? params.env[PRINCIPAL_ENV_VAR]
  if (id === undefined || id.length === 0) {
    throw new CliPrincipalError(
      `no principal given: pass ${PRINCIPAL_FLAG} <id> or set ${PRINCIPAL_ENV_VAR}`,
    )
  }
  const principal = await params.principals.getById(id)
  if (!principal) throw new CliPrincipalError(`unknown principal: ${id}`)
  return principal
}
