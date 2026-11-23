/**
 * Capabilities (plan/phase-substrate.md §3.3): system programs a workload may
 * call. install.sh installs each one, pinned and checksum-verified, under
 * /opt/ee/capabilities/<name>; a workload that declares it in ee.json gets its
 * path in an environment variable (EE_CAP_<NAME>). The host's read-only /opt is
 * visible to every sandboxed unit (ProtectSystem=strict), so no extra mount.
 */

export const CAPABILITIES_DIR = '/opt/ee/capabilities'

/** Playwright's chrome-headless-shell (brand site capture). scripts/release.sh pins the build. */
export const CHROMIUM_EXECUTABLE = `${CAPABILITIES_DIR}/chromium/chrome-headless-shell`

export const CAPABILITIES = {
  chromium: { env: 'EE_CAP_CHROMIUM', path: CHROMIUM_EXECUTABLE },
} as const satisfies Record<string, { env: string; path: string }>

export type CapabilityName = keyof typeof CAPABILITIES

export const CAPABILITY_NAMES = Object.keys(CAPABILITIES) as CapabilityName[]

function capability(name: string): (typeof CAPABILITIES)[CapabilityName] {
  const c = (CAPABILITIES as Record<string, (typeof CAPABILITIES)[CapabilityName]>)[name]
  if (!c) throw new Error(`capability ${name} is not in the catalog`)
  return c
}

/** The environment a unit gets for the capabilities its contract declares. */
export function capabilityEnv(declared: readonly string[]): Record<string, string> {
  return Object.fromEntries(declared.map((name) => [capability(name).env, capability(name).path]))
}

/** Fails loud when a declared capability is missing on this server (never deploy a workload that can't run it). */
export async function assertCapabilitiesInstalled(
  exists: (path: string) => Promise<boolean>,
  workload: string,
  declared: readonly string[],
): Promise<void> {
  for (const name of declared) {
    const { path } = capability(name)
    if (!(await exists(path))) {
      throw new Error(`${workload}: capability ${name} is not installed on this server (${path}); re-run install.sh to install it`)
    }
  }
}
