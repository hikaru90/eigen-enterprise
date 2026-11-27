import type { Actions, PageServerLoad } from './$types'
import {
  REPUTATION_THRESHOLDS,
  REPUTATION_VOLUME,
  REPUTATION_WINDOW,
} from '../../../../../../modules/email/platform/reputation'
import { reputationOut } from '../../../../../../modules/email/platform/reputation-service'
import { emailPlatform } from '../../../../../../modules/email/platform/service'
import { act, field, requireAdmin, requireMember } from '../access.server'

/**
 * Email › Setup › Reputation (plan/mail-reputation.md): the sender reputation against Amazon SES's
 * criteria, what is flagged, whether sending is held, the check history and the resumes. The page is
 * a client of email.reputation_get / _check / _resume.
 */
export const load: PageServerLoad = async ({ locals }) => {
  await requireMember(locals)
  const platform = emailPlatform()
  const settings = await platform.owlery.settings()
  if (!settings) return { configured: false as const }
  const [view, history, flows] = await Promise.all([
    platform.reputation.view(),
    platform.reputation.history(48),
    platform.audience.listFlows(),
  ])
  const flowName = new Map(flows.map((f) => [`flow:${f.id}`, f.name]))
  const out = reputationOut(view)
  return {
    configured: true as const,
    reputation: {
      ...out,
      slices: out.slices.map((s) => ({
        ...s,
        label:
          s.dimension === 'ref' && flowName.has(s.value)
            ? `Flow “${flowName.get(s.value)}”`
            : s.label,
        flowId:
          s.dimension === 'ref' && s.value.startsWith('flow:')
            ? s.value.slice('flow:'.length)
            : null,
        apiKey: s.dimension === 'ref' && s.value.startsWith('api_key:'),
      })),
    },
    history: history.checks.map((c) => ({
      id: c.id,
      at: c.checkedAt.toISOString(),
      band: c.band,
      recipients: c.recipients,
      bounceRate: c.bounceRate,
      complaintRate: c.complaintRate,
      amazon: c.awsStatus,
      amazonError: c.awsError,
    })),
    resumes: history.resets.map((r) => ({
      id: r.id,
      at: r.createdAt.toISOString(),
      reason: r.reason,
      band: r.band,
      bounceRate: r.bounceRate,
    })),
    criteria: {
      thresholds: REPUTATION_THRESHOLDS,
      volume: REPUTATION_VOLUME,
      window: REPUTATION_WINDOW,
    },
  }
}

export const actions: Actions = {
  /** "Check now": reads Amazon's verdict and records a check (email.reputation_check). */
  check: async ({ locals }) => {
    await requireAdmin(locals)
    return act('check', 'Checking the sender reputation at Amazon SES', async () => ({
      band: (await emailPlatform().reputation.check()).band,
    }))
  },
  /** Resume after a hold, with what was fixed (email.reputation_resume). */
  resume: async ({ locals, request }) => {
    const me = await requireAdmin(locals)
    const reason = field(await request.formData(), 'reason')
    return act('resume', 'Resuming sending after a reputation hold', async () => ({
      band: (await emailPlatform().reputation.resume(me.userId, reason)).view.band,
    }))
  },
}
