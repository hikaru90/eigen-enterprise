import { appKernel } from '$lib/server/boot'
import { randomUUID } from 'node:crypto'
import { KernelError } from '$lib/kernel/errors'
import type { ToolContext } from '$lib/kernel/types'
import { decideApprovalAsOwner } from '$lib/server/approvals/owner-decision'
import { ensureSystemModulesActive } from '../../../../modules/index'
import { AppUserError } from '../../../../modules/website/apps/contract'

/**
 * Website pages run every read and change through the kernel registry as the
 * signed-in owner (permission-checked, audited). The owner's click IS their
 * decision: when the approval mode gates the tool, the click is recorded as
 * their approval, then the tool runs (D11: owner clicks are human actions).
 */

function ownerCtx(user: { id: string }): ToolContext {
  return { principal: { id: user.id, kind: 'human', roles: ['admin'] }, requestId: randomUUID() }
}

export async function ownerRun<T>(user: { id: string }, tool: string, input: unknown): Promise<T> {
  const k = await appKernel()
  await ensureSystemModulesActive(k)
  try {
    return (await k.registry.execute(tool, input, ownerCtx(user))) as T
  } catch (err) {
    const approvalId =
      err instanceof KernelError && err.code === 'approval_required'
        ? err.details?.approvalId
        : undefined
    if (typeof approvalId !== 'string') throw err
    await decideApprovalAsOwner(k.registry, user, approvalId, 'approved')
    return (await k.registry.execute(tool, input, ownerCtx(user))) as T
  }
}

const APP_NAME = 'Check the app name: lowercase letters, digits and dashes, 2 to 31 long.'
const DOMAIN =
  'Check the domain: enter just the host name, like shop.example.com (no https:// and no /).'
const ENV_NAME = 'Check the variable name: CAPITALS, digits and _, like API_KEY.'

/** Per tool, the owner's sentence for each rejected field (keyed by the input's top-level key). */
const FIELD_HINTS: Record<string, Record<string, string>> = {
  'website.app_deploy': {
    name: APP_NAME,
    repo: 'Check the repository: owner/name, like kindred/site.',
    branch: 'Check the branch name.',
    host: DOMAIN,
    hosts:
      'Check the domains: host names separated by commas, like shop.example.com, www.shop.example.com (no https:// and no /).',
    contract: 'Check the build form.',
  },
  'website.app_domain_set': { name: APP_NAME, host: DOMAIN },
  'website.app_env_set': {
    name: APP_NAME,
    key: ENV_NAME,
    value: 'Check the value: 1 to 16384 characters.',
  },
  'substrate.secret_set': { name: ENV_NAME, value: 'Check the secret value.' },
}

/** The first rejected field, named — never "some of what was entered" when the field is known. */
function invalidInputMessage(err: KernelError): string {
  const tool = err.details?.tool
  const issues = err.details?.issues
  const first = Array.isArray(issues) ? (issues[0] as { path?: unknown }) : null
  const key = typeof first?.path === 'string' ? first.path.split('.')[0]! : null
  const hint = typeof tool === 'string' && key ? FIELD_HINTS[tool]?.[key] : undefined
  return hint ?? 'Some of what was entered is not valid. Check it and try again.'
}

/** code ↔ harness ↔ user: a plain sentence for the page; details go to the server log. */
export function plainAppMessage(err: unknown): string {
  if (err instanceof AppUserError) return err.message
  if (err instanceof KernelError) {
    if (err.code === 'permission_denied') return 'Only an admin can do this.'
    if (err.code === 'invalid_input') return invalidInputMessage(err)
    if (err.code === 'approval_required') return 'This is waiting for your approval in the chat.'
  }
  return 'Something went wrong while deploying. Try again; if it keeps happening, ask in the chat.'
}

export function logAppFailure(tool: string, err: unknown): void {
  const cause = err instanceof Error && err.cause instanceof Error ? ` (${err.cause.message})` : ''
  console.error(
    `[website/apps] ${tool} failed: ${err instanceof Error ? err.message : String(err)}${cause}`,
  )
}
