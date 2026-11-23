import { registerAdminTools } from '$lib/kernel/admin-bootstrap'
import { KernelError } from '$lib/kernel/errors'
/**
 * The demo company from a repo checkout (plan/phase-demo-company.md DC1):
 *
 *   npm run demo-company -- seed     fill an empty, claimed company with Northwind Studio
 *
 * A thin entry over the registry tool demo.seed_company (modules/demo/): it
 * switches the demo module on and calls the tool as the person who claimed the
 * company, the operator at this terminal. When the approval mode holds the
 * call, the operator is the owner deciding it (kernel.approvals_decide), then
 * the call runs. Needs the app's env (DATABASE_URL, auth secrets). On an
 * installed box the tool is the way (the release ships no scripts/*.ts).
 */
import type { ToolContext } from '$lib/kernel/types'
import { personFor } from '$lib/server/auth/user-role'
import { dbMemberStore } from '$lib/server/members/db-store'
import { DEMO_MODULE_ID, DEMO_SEED_TOOL } from '../modules/demo/manifest'
import { bootstrapKernel, ensureSystemModulesActive } from '../modules/index'

/** The person who claimed this company; none = unclaimed, which the seed refuses. */
async function claimedOwner(): Promise<ToolContext> {
  const owners = (await dbMemberStore.listMembers()).filter((m) => m.role === 'owner')
  if (owners.length !== 1)
    throw new Error(`the company is not claimed (found ${owners.length} owners): claim it first, then seed`)
  const person = await personFor(owners[0]!.id)
  if (!person) throw new Error(`the owner ${owners[0]!.id} is not a member`)
  return { principal: { id: person.id, kind: 'human', roles: person.roles }, requestId: crypto.randomUUID() }
}

async function main(argv: string[]): Promise<number> {
  if (argv[0] !== 'seed' || argv.length !== 1) {
    console.error('usage: demo-company seed')
    return 1
  }
  const kernel = bootstrapKernel()
  // What the app does at boot (src/lib/server/boot.ts): the admin tools, the system modules on.
  await registerAdminTools(kernel)
  await ensureSystemModulesActive(kernel)
  const owner = await claimedOwner()
  await kernel.registry.execute('kernel.module_activate', { module_id: DEMO_MODULE_ID }, owner)
  let result: unknown
  try {
    result = await kernel.registry.execute(DEMO_SEED_TOOL, {}, owner)
  } catch (err) {
    const approvalId =
      err instanceof KernelError && err.code === 'approval_required' ? err.details?.approvalId : undefined
    if (typeof approvalId !== 'string') throw err
    await kernel.registry.execute('kernel.approvals_decide', { approval_id: approvalId, decision: 'approved' }, owner)
    result = await kernel.registry.execute(DEMO_SEED_TOOL, {}, owner)
  }
  console.info(JSON.stringify(result, null, 2))
  return 0
}

try {
  process.exit(await main(process.argv.slice(2).filter((a) => a !== '--')))
} catch (err) {
  console.error(`[demo-company] ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`)
  process.exit(1)
}
