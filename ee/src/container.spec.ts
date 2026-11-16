import { describe, expect, it } from 'vitest'
import { assertContainerHostReady, detectContainer, HOST_SYSCTLS, type ContainerSys } from './container.ts'

function fake(virt: { code: number; stdout: string } | Error, proc: Record<string, string | null> = {}) {
  const runs: string[] = []
  const sys: ContainerSys = {
    run: async (cmd, args) => {
      runs.push(`${cmd} ${args.join(' ')}`)
      if (virt instanceof Error) throw virt
      return { ...virt, stderr: '' }
    },
    readFile: async (p) => proc[p] ?? null,
  }
  return { sys, runs }
}

const good = Object.fromEntries(HOST_SYSCTLS.map((s) => [s.path, `${s.min}\n`]))

describe('detectContainer', () => {
  it('names the container technology (Incus reports lxc)', async () => {
    const { sys, runs } = fake({ code: 0, stdout: 'lxc\n' })
    expect(await detectContainer(sys)).toBe('lxc')
    expect(runs).toEqual(['systemd-detect-virt --container'])
  })
  it('is null on a VM or bare metal (exit 1, "none")', async () => {
    expect(await detectContainer(fake({ code: 1, stdout: 'none\n' }).sys)).toBeNull()
  })
  it('fails loud when systemd-detect-virt cannot answer', async () => {
    await expect(detectContainer(fake({ code: 2, stdout: '' }).sys)).rejects.toThrow(/systemd-detect-virt/)
    await expect(detectContainer(fake(new Error('ENOENT')).sys)).rejects.toThrow(/ENOENT/)
  })
})

describe('assertContainerHostReady', () => {
  it('outside a container changes nothing and reads nothing', async () => {
    const logs: string[] = []
    await assertContainerHostReady(fake({ code: 0, stdout: '' }).sys, null, (l) => logs.push(l))
    expect(logs).toEqual([])
  })
  it('in a container accepts host values at or above the minimum and says the host owns them', async () => {
    const logs: string[] = []
    const { sys } = fake({ code: 0, stdout: '' }, Object.fromEntries(HOST_SYSCTLS.map((s) => [s.path, `${s.min * 2}\n`])))
    await assertContainerHostReady(sys, 'lxc', (l) => logs.push(l))
    expect(logs).toHaveLength(HOST_SYSCTLS.length)
    expect(logs[0]).toMatch(/in a container \(lxc\): net\.core\.rmem_max=10000000 .* is the host's job \(ee-host setup\)/)
  })
  it('refuses, naming the host setting, when a value is too small', async () => {
    const { sys } = fake({ code: 0, stdout: '' }, { ...good, '/proc/sys/net/core/wmem_max': '212992\n' })
    await expect(assertContainerHostReady(sys, 'lxc', () => {})).rejects.toThrow(
      /net\.core\.wmem_max is 212992.*at least 5000000.*on the host/,
    )
  })
  it('refuses when the value cannot be read', async () => {
    const { sys } = fake({ code: 0, stdout: '' }, { ...good, '/proc/sys/net/core/rmem_max': null })
    await expect(assertContainerHostReady(sys, 'lxc', () => {})).rejects.toThrow(/cannot read \/proc\/sys\/net\/core\/rmem_max/)
  })
})
