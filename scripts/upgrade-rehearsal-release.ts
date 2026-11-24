import { writeFileSync } from 'node:fs'
/**
 * The previous release's side of the upgrade rehearsal (scripts/upgrade-rehearsal.mjs).
 *
 * This file is COPIED into the previous release's checkout and runs there,
 * with that release's own code (its kernel, modules, DB layer and vite config):
 * it is how "the previous app version, still running during blue/green" reads
 * the database. It only uses kernel entry points that every release since the
 * demo company (DC1) has: bootstrapKernel, registerAdminTools,
 * ensureSystemModulesActive, registry.execute, the Better Auth adapter.
 *
 *   seed <owner-email>   claim the empty company (first account = owner, as on a
 *                        dev/test instance) and seed the demo company through
 *                        demo.seed_company, as scripts/demo-company.ts does
 *   smoke <out.json>     boot the registry like the app does and call every read
 *                        tool in scripts/upgrade-rehearsal-smoke.mjs as the owner;
 *                        one result per tool goes to <out.json>
 */
import { registerAdminTools } from '$lib/kernel/admin-bootstrap'
import { KernelError } from '$lib/kernel/errors'
import type { ToolContext } from '$lib/kernel/types'
import { auth } from '$lib/server/auth'
import { personFor } from '$lib/server/auth/user-role'
import { bootApp } from '$lib/server/boot'
import { withDbUser } from '$lib/server/db'
import { dbMemberStore } from '$lib/server/members/db-store'
import { bootstrapKernel, ensureSystemModulesActive } from '../modules/index'
import { SMOKE, summarize, type SmokeOutputs } from './upgrade-rehearsal-smoke.mjs'

/** The signed-out DB session (hooks.server.ts): an account is made before its person exists. */
const SIGNED_OUT = ''

async function bootedKernel() {
  const kernel = bootstrapKernel()
  // What the app does at boot (src/lib/server/boot.ts): the admin tools, the system modules on.
  await registerAdminTools(kernel)
  await ensureSystemModulesActive(kernel)
  return kernel
}

async function ownerContext(): Promise<ToolContext> {
  const owners = (await dbMemberStore.listMembers()).filter((m) => m.role === 'owner')
  if (owners.length !== 1) throw new Error(`expected exactly one owner, found ${owners.length}`)
  const person = await personFor(owners[0]!.id)
  if (!person) throw new Error(`the owner ${owners[0]!.id} is not a member`)
  return {
    principal: { id: person.id, kind: 'human', roles: person.roles },
    requestId: crypto.randomUUID(),
  }
}

async function seed(email: string): Promise<void> {
  // Claim: on an instance not under ee the first account is the owner (owner-policy.ts),
  // made through Better Auth's own user-create hooks, like the email-code sign-in.
  const ctx = await auth.$context
  await withDbUser(SIGNED_OUT, () =>
    ctx.internalAdapter.createUser(
      { email, name: 'Rehearsal Owner', emailVerified: true },
      { method: 'email-otp' },
    ),
  )
  const kernel = await bootedKernel()
  const owner = await ownerContext()
  await kernel.registry.execute('kernel.module_activate', { module_id: 'demo' }, owner)
  let result: unknown
  try {
    result = await kernel.registry.execute('demo.seed_company', {}, owner)
  } catch (err) {
    const approvalId =
      err instanceof KernelError && err.code === 'approval_required'
        ? err.details?.approvalId
        : undefined
    if (typeof approvalId !== 'string') throw err
    await kernel.registry.execute(
      'kernel.approvals_decide',
      { approval_id: approvalId, decision: 'approved' },
      owner,
    )
    result = await kernel.registry.execute('demo.seed_company', {}, owner)
  }
  console.info(`[rehearsal] seeded: ${JSON.stringify(result)}`)
}

function errorText(err: unknown): string {
  if (err instanceof KernelError) return `${err.code}: ${err.message}`
  if (err instanceof Error) {
    // A Drizzle query error wraps the Postgres one (the missing column or relation) as its cause;
    // the cause leads, the query is cut to its start.
    if (err.cause instanceof Error) {
      const query = err.message.split('\n')[0]!
      return `${err.cause.message} (${query.length > 140 ? `${query.slice(0, 140)}…` : query})`
    }
    return err.message
  }
  return String(err)
}

async function smoke(outPath: string): Promise<void> {
  // The app's own composition root (what the running server boots): its kernel, wired stores and all.
  const { kernel } = await bootApp()
  const owner = await ownerContext()
  const outputs: SmokeOutputs = {}
  const results: { tool: string; ok: boolean; summary?: string; error?: string }[] = []
  for (const item of SMOKE) {
    const name = item.as ?? item.tool
    const ctx = { ...owner, requestId: crypto.randomUUID() }
    try {
      // A read in this release's own registry, or it is no read smoke (a missing tool fails here too).
      const auditClass = kernel.registry.get(item.tool)?.auditClass
      if (auditClass !== 'read') {
        throw new Error(
          auditClass
            ? `not a read tool (audit class ${auditClass})`
            : 'no such tool in this release',
        )
      }
      const input = typeof item.input === 'function' ? item.input(outputs) : item.input
      const out = await kernel.registry.execute(item.tool, input, ctx)
      outputs[name] = out
      results.push({ tool: name, ok: true, summary: summarize(out) })
    } catch (err) {
      results.push({ tool: name, ok: false, error: errorText(err) })
    }
  }
  writeFileSync(outPath, JSON.stringify(results, null, 2))
  console.info(
    `[rehearsal] smoke: ${results.filter((r) => r.ok).length}/${results.length} read tools ok`,
  )
}

async function main(argv: string[]): Promise<number> {
  const [cmd, arg] = argv
  if (cmd === 'seed' && arg) await seed(arg)
  else if (cmd === 'smoke' && arg) await smoke(arg)
  else {
    console.error('usage: upgrade-rehearsal-release seed <owner-email> | smoke <out.json>')
    return 2
  }
  return 0
}

try {
  process.exit(await main(process.argv.slice(2).filter((a) => a !== '--')))
} catch (err) {
  console.error(`[rehearsal] ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`)
  process.exit(1)
}
