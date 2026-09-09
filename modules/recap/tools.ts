import type { RecapDeps } from './types'
import { z } from 'zod'
import type { ToolDescriptor } from '$lib/kernel/types'
import { runDailyRecap } from './schedule'

const runNowInput = z.object({}).strict()

/** `recap.run_now`: run the daily recap immediately (owner/admin testing path). */
export function createRecapRunNowTool(deps: RecapDeps): ToolDescriptor {
  return {
    name: 'recap.run_now',
    module: 'recap',
    summary:
      'Run the company recap immediately: summarize the last 24h of kernel events and deliver the summary to allowlisted Telegram owner chats.',
    auditClass: 'mutate',
    inputSchema: runNowInput,
    permission: { roles: ['owner', 'admin'] },
    handler: async (_ctx, input) => {
      runNowInput.parse(input)
      return runDailyRecap(deps, new Date())
    },
  }
}
