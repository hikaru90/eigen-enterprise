import type { RequestEvent } from '@sveltejs/kit'
import { randomUUID } from 'node:crypto'
import { fail } from '@sveltejs/kit'
import type { AiUsageToday } from '$lib/ai-usage/usage'
import { KernelError } from '$lib/kernel/errors'
import { getUserRole, isAdminRole, kernelRolesFor } from '$lib/server/auth/user-role'
import { appKernel } from '$lib/server/boot'
import { ownerRun } from '$lib/server/website/owner-run'

/**
 * Settings › AI provider, "Daily AI cap per member" (DC3): a client of the registry tools.
 * Every person sees their own usage today (settings.my_ai_usage, as themselves); owner and
 * admins change the cap (settings.member_ai_cap_set — their click is their approval, ownerRun).
 */

export type MemberAiCapPageData = { usage: AiUsageToday }

export async function loadMemberAiCap(userId: string): Promise<MemberAiCapPageData> {
  const role = await getUserRole(userId)
  if (!role) throw new Error(`No member ${userId}: the AI usage is read for a member of the company.`)
  const kernel = await appKernel()
  const usage = (await kernel.registry.execute(
    'settings.my_ai_usage',
    {},
    { principal: { id: userId, kind: 'human', roles: kernelRolesFor(role) }, requestId: randomUUID() },
  )) as AiUsageToday
  return { usage }
}

/** The form's amount: empty = no cap; otherwise a positive number of dollars. */
function parseCapField(raw: string): { ok: true; value: number | null } | { ok: false } {
  const text = raw.trim()
  if (text === '') return { ok: true, value: null }
  const value = Number(text)
  return Number.isFinite(value) && value > 0 ? { ok: true, value } : { ok: false }
}

export async function setMemberAiCapAction(event: RequestEvent) {
  const user = event.locals.user
  if (!user) return fail(401, { capMessage: 'You must be signed in.' })
  if (!isAdminRole(await getUserRole(user.id))) {
    return fail(403, { capMessage: 'Only owners and admins set the daily AI cap.' })
  }
  const parsed = parseCapField((await event.request.formData()).get('capUsd')?.toString() ?? '')
  if (!parsed.ok) {
    return fail(400, { capMessage: 'Enter an amount in dollars above 0, or leave it empty for no cap.' })
  }
  try {
    const out = await ownerRun<{ capUsd: number | null }>({ id: user.id }, 'settings.member_ai_cap_set', {
      cap_usd: parsed.value,
    })
    return {
      capMessage:
        out.capUsd === null
          ? 'Saved: no daily AI cap for members.'
          : `Saved: members can use up to $${out.capUsd.toFixed(2)} of AI per day.`,
    }
  } catch (err) {
    if (err instanceof KernelError && err.code === 'invalid_input') {
      return fail(400, { capMessage: 'Enter an amount in dollars above 0, or leave it empty for no cap.' })
    }
    throw err
  }
}
