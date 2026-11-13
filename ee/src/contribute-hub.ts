/**
 * Where an install shares its de-personalised Contribute proposals
 * (plan/contribute-phone-home.md §5): the installer writes it as the os
 * workload's CONTRIBUTE_HUB_URL. Official installs share with the project's
 * central board; `--contribute-hub off` (the local test box, owner Q8) or a
 * fork's own hub replace it, and the choice is kept across upgrades. The app
 * itself has no default: without the env it shows "central board not
 * configured" and sends nothing.
 */

export const OFFICIAL_CONTRIBUTE_HUB = 'https://os.cerberusblue.com'

export type ContributeHub = string | 'off'

export function parseContributeHubFlag(flag: string): ContributeHub {
  if (flag === 'off') return 'off'
  let url: URL
  try {
    url = new URL(flag)
  } catch {
    throw new Error(`--contribute-hub "${flag}" must be https://<host> of a central board, or off`)
  }
  if (url.protocol !== 'https:') throw new Error(`--contribute-hub "${flag}" must use https`)
  if (url.origin !== flag) throw new Error(`--contribute-hub "${flag}" must be an origin only (e.g. ${OFFICIAL_CONTRIBUTE_HUB})`)
  return flag
}

/** An explicit flag wins (and is saved); a plain re-run (upgrade) keeps what the company has. */
export function resolveContributeHub(flag: ContributeHub | undefined, stored: ContributeHub): ContributeHub {
  return flag ?? stored
}

/** The os workload's env with CONTRIBUTE_HUB_URL set to the hub, or removed when sharing goes nowhere. */
export function contributeHubEnv(env: Record<string, string>, hub: ContributeHub): Record<string, string> {
  const { CONTRIBUTE_HUB_URL: _previous, ...rest } = env
  return hub === 'off' ? rest : { ...rest, CONTRIBUTE_HUB_URL: hub }
}
