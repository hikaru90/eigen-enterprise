import { describe, expect, it } from 'vitest'
import { KernelError } from '$lib/kernel/errors'
import type { ToolContext } from '$lib/kernel/types'
import { EeClient, type EeTransport } from '$lib/server/ee/client'
import { websiteManifest } from '../manifest'
import { SUBSTRATE_TOOL_NAMES } from './manifest'
import { createSubstrateTools } from './tools'

const human: ToolContext = { principal: { id: 'u1', kind: 'human', roles: ['admin'] }, requestId: 'r1' }
const agent: ToolContext = { principal: { id: 'orchestrator', kind: 'agent', roles: ['admin', 'agent'] }, requestId: 'r2' }

function recordingTransport(answer: { status: number; data: unknown } = { status: 200, data: { rev: 'abc', reconcileError: null } }) {
  const calls: Array<{ method: string; path: string; body?: unknown }> = []
  const transport: EeTransport = async (method, path, body) => {
    calls.push({ method, path, body })
    return answer
  }
  return { calls, transport }
}

function tools(transport: EeTransport) {
  return new Map(createSubstrateTools({ client: new EeClient(transport) }).map((t) => [t.name, t]))
}

describe('substrate module', () => {
  it('builds exactly the manifest tools', () => {
    const { transport } = recordingTransport()
    expect([...tools(transport).keys()].sort()).toEqual([...SUBSTRATE_TOOL_NAMES].sort())
    // Hosting folded into the website module (platform step 1); names unchanged.
    expect(websiteManifest.tools).toEqual(expect.arrayContaining([...SUBSTRATE_TOOL_NAMES]))
    for (const t of tools(transport).values()) expect(t.module).toBe('website')
  })

  it('status reports managed:false explicitly when not running under ee', async () => {
    const t = tools(async () => {
      const { SubstrateUnavailableError } = await import('$lib/server/ee/client')
      throw new SubstrateUnavailableError('ENOENT')
    })
    const out = (await t.get('substrate.status')!.handler(agent, {})) as { managed: boolean; reason: string }
    expect(out.managed).toBe(false)
    expect(out.reason).toMatch(/not running under ee/)
  })

  it('a human adds a domain; the commit is authored by that human', async () => {
    const { calls, transport } = recordingTransport()
    await tools(transport).get('substrate.domain_add')!.handler(human, { host: 'Kindred.Digital', role: 'public' })
    expect(calls[0]).toEqual({
      method: 'POST',
      path: '/v1/domains',
      body: { host: 'kindred.digital', role: 'public', workload: 'os', author: 'human:u1' },
    })
  })

  it.each(['substrate.domain_add', 'substrate.domain_remove', 'substrate.app_remove', 'substrate.secret_set'])(
    '%s is human-only (D11): the agent is refused before ee is called',
    async (name) => {
      const { calls, transport } = recordingTransport()
      const input = { host: 'a.example.com', role: 'app', workload: 'x1', name: 'x1', value: 'v' }
      const fixed = name === 'substrate.secret_set' ? { workload: 'x1', name: 'API_KEY', value: 'v' } : input
      await expect(tools(transport).get(name)!.handler(agent, fixed)).rejects.toBeInstanceOf(KernelError)
      expect(calls).toEqual([])
    },
  )

  it('surfaces ee errors loudly', async () => {
    const { transport } = recordingTransport({ status: 400, data: { detail: 'only eigenEnterprise (os) has a console host' } })
    await expect(
      tools(transport).get('substrate.domain_add')!.handler(human, { host: 'x.example.com', role: 'console', workload: 'app1' }),
    ).rejects.toThrow(/console host/)
  })

  it('never echoes a secret value back', async () => {
    const { transport } = recordingTransport({ status: 200, data: { ok: true, reconcileError: null } })
    const out = await tools(transport).get('substrate.secret_set')!.handler(human, { workload: 'app1', name: 'API_KEY', value: 'super-secret' })
    expect(JSON.stringify(out)).not.toContain('super-secret')
  })
})
