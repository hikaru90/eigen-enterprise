import type { System } from './system.ts'

/**
 * Hosted companies run in an unprivileged Incus system container
 * (plan/phase-managed-box.md D8). Kernel tunables are the host's there: a
 * container can't set them, so the install verifies what it needs and refuses
 * loudly instead of skipping. A VM or bare metal is unaffected.
 */
export type ContainerSys = Pick<System, 'run' | 'readFile'>

/** The container technology (`lxc` under Incus), or null on a VM / bare metal. */
export async function detectContainer(sys: ContainerSys): Promise<string | null> {
  const r = await sys.run('systemd-detect-virt', ['--container'])
  const out = r.stdout.trim()
  if (r.code === 0 && out && out !== 'none') return out
  if (r.code === 1 && (out === 'none' || out === '')) return null
  throw new Error(`systemd-detect-virt --container failed (exit ${r.code}): ${(r.stderr || out).trim()}`)
}

/**
 * What the host must provide. LiveKit's UDP mux needs large socket buffers
 * (it warns and drops media below ~5 MB); a VM install leaves them as the OS has them.
 */
export const HOST_SYSCTLS = [
  { key: 'net.core.rmem_max', path: '/proc/sys/net/core/rmem_max', min: 5_000_000, why: 'LiveKit UDP receive buffer' },
  { key: 'net.core.wmem_max', path: '/proc/sys/net/core/wmem_max', min: 5_000_000, why: 'LiveKit UDP send buffer' },
] as const

export async function assertContainerHostReady(sys: ContainerSys, container: string | null, log: (line: string) => void): Promise<void> {
  if (container === null) return
  for (const s of HOST_SYSCTLS) {
    const raw = await sys.readFile(s.path)
    if (raw === null) throw new Error(`in a container (${container}): cannot read ${s.path} (${s.key}, ${s.why})`)
    const value = Number(raw.trim())
    if (!Number.isInteger(value) || value < s.min) {
      throw new Error(
        `in a container (${container}): ${s.key} is ${raw.trim()}, ${s.why} needs at least ${s.min}. ` +
          `A container cannot set it: set ${s.key}=${s.min} on the host (ee-host setup), then re-run.`,
      )
    }
    log(`in a container (${container}): ${s.key}=${value} (needs >= ${s.min}) is the host's job (ee-host setup)`)
  }
}
