import { z } from 'zod'
import type { ToolDescriptor } from '$lib/kernel/types'
import { CONTRIBUTION_STATUSES, OPEN_STATUSES, type ContributionStatus } from '../types'
import { CONTRIBUTE_HUB_MODULE_ID } from './manifest'
import { getHubProposal, listHubProposals, revokeInstall, type HubDeps } from './service'

/**
 * contribute_hub.* kernel tools: how the owner's agent reads the central
 * board (in-app assistant, the hub's MCP, `ee contribute_hub.list`) — what
 * every install shared, without names — and refuses an abusive install.
 * Revoking waits on the approval mode (APPROVAL_REQUIRED_TOOLS).
 */

const listInput = z
  .object({
    status: z
      .enum([...CONTRIBUTION_STATUSES, 'open', 'all'])
      .default('open')
      .describe('"open" (default) = requested + in_progress; "all" = everything incl. shipped and declined'),
  })
  .strict()
const getInput = z.object({ install_id: z.uuid(), remote_id: z.uuid() }).strict()
const revokeInput = z.object({ install_id: z.uuid() }).strict()

async function liveDeps(): Promise<HubDeps> {
  const { contributeHubDeps } = await import('./live')
  return contributeHubDeps()
}

export function createContributeHubTools(opts: { deps?: () => Promise<HubDeps> } = {}): ToolDescriptor[] {
  const deps = opts.deps ?? liveDeps
  return [
    {
      name: 'contribute_hub.list',
      module: CONTRIBUTE_HUB_MODULE_ID,
      summary:
        'List the proposals every eigenEnterprise install shared with the central board (no names, no company): install_id, remote_id, summary (English), language, kind, area, status, score, app_version, days. Default: open ones, highest score first.',
      auditClass: 'read',
      inputSchema: listInput,
      permission: { roles: ['admin', 'agent'] },
      handler: async (_ctx, input) => {
        const i = listInput.parse(input)
        const statuses: readonly ContributionStatus[] =
          i.status === 'open' ? OPEN_STATUSES : i.status === 'all' ? CONTRIBUTION_STATUSES : [i.status]
        return { proposals: await listHubProposals(await deps(), statuses) }
      },
    },
    {
      name: 'contribute_hub.get',
      module: CONTRIBUTE_HUB_MODULE_ID,
      summary: 'Read one shared proposal from the central board by install_id and remote_id.',
      auditClass: 'read',
      inputSchema: getInput,
      permission: { roles: ['admin', 'agent'] },
      handler: async (_ctx, input) => {
        const i = getInput.parse(input)
        return getHubProposal(await deps(), i.install_id, i.remote_id)
      },
    },
    {
      name: 'contribute_hub.revoke_install',
      module: CONTRIBUTE_HUB_MODULE_ID,
      summary:
        'Refuse an install on the central board from now on (spam, abuse): every request it makes gets 403 and it cannot register again. What it already shared stays. Idempotent.',
      auditClass: 'mutate',
      approvalRisk: 'destructive',
      activity: (input: z.infer<typeof revokeInput>) => `Revoked install ${input.install_id.slice(0, 8)} on the central board`,
      inputSchema: revokeInput,
      permission: { roles: ['admin', 'agent'] },
      handler: async (_ctx, input) => revokeInstall(await deps(), revokeInput.parse(input).install_id),
    },
  ]
}
