import type { HubProposalDto } from './types'
import { describe, expect, it } from 'vitest'
import type { ToolContext } from '$lib/kernel/types'
import { CONTRIBUTE_HUB_TOOL_NAMES } from './manifest'
import { register, upsertContribution } from './service'
import { fixture, payload, putReq, registerBody, testInstall } from './test-fixtures'
import { createContributeHubTools } from './tools'

const agentCtx: ToolContext = { principal: { id: 'agent-1', kind: 'agent', roles: ['agent'] }, requestId: 'r1' }

async function seeded() {
  const f = fixture()
  const a = testInstall()
  await register(f.deps, registerBody(a))
  const open = payload({ score: 3 })
  const shipped = payload({ status: 'shipped', shipped_day: '2026-11-13' })
  await upsertContribution(f.deps, putReq(a, open, f.clock.now), open.remote_id)
  await upsertContribution(f.deps, putReq(a, shipped, f.clock.now + 1), shipped.remote_id)
  const tools = Object.fromEntries(createContributeHubTools({ deps: async () => f.deps }).map((t) => [t.name, t]))
  return { f, a, open, shipped, tools }
}

describe('contribute_hub.* tools', () => {
  it('match the manifest, read-only except the gated revoke', () => {
    const tools = createContributeHubTools()
    expect(tools.map((t) => t.name)).toEqual([...CONTRIBUTE_HUB_TOOL_NAMES])
    expect(Object.fromEntries(tools.map((t) => [t.name, [t.auditClass, t.approvalRisk ?? null, t.permission.roles]]))).toEqual({
      'contribute_hub.list': ['read', null, ['admin', 'agent']],
      'contribute_hub.get': ['read', null, ['admin', 'agent']],
      'contribute_hub.revoke_install': ['mutate', 'destructive', ['admin', 'agent']],
    })
  })

  it('lists open proposals by default, all on request, and gets one', async () => {
    const { a, open, shipped, tools } = await seeded()
    const listed = (await tools['contribute_hub.list'].handler(agentCtx, {})) as { proposals: HubProposalDto[] }
    expect(listed.proposals.map((p) => p.remoteId)).toEqual([open.remote_id])
    const all = (await tools['contribute_hub.list'].handler(agentCtx, { status: 'all' })) as { proposals: HubProposalDto[] }
    expect(all.proposals).toHaveLength(2)
    const got = (await tools['contribute_hub.get'].handler(agentCtx, { install_id: a.installId, remote_id: shipped.remote_id })) as HubProposalDto
    expect(got).toMatchObject({ status: 'shipped', shippedDay: '2026-11-13' })
    await expect(tools['contribute_hub.list'].handler(agentCtx, { status: 'all', author: 'x' })).rejects.toThrow()
  })

  it('revokes an install and says so in plain words', async () => {
    const { f, a, tools } = await seeded()
    const out = await tools['contribute_hub.revoke_install'].handler(agentCtx, { install_id: a.installId })
    expect(out).toMatchObject({ install_id: a.installId })
    expect((await f.store.getInstall(a.installId))?.revokedAt).not.toBeNull()
    expect(tools['contribute_hub.revoke_install'].activity!({ install_id: a.installId }, out)).toBe(
      `Revoked install ${a.installId.slice(0, 8)} on the central board`,
    )
  })
})
