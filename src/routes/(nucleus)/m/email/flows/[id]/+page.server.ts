import type { Actions, PageServerLoad } from './$types'
import { error, redirect } from '@sveltejs/kit'
import { AudienceError } from '../../../../../../../modules/email/platform/flows/service'
import { emailPlatform } from '../../../../../../../modules/email/platform/service'
import { act, field, requireAdmin, requireMember } from '../../access.server'

/** The flow editor (a vertical list of steps), its people and what happened. */
export const load: PageServerLoad = async ({ locals, params }) => {
  await requireMember(locals)
  const p = emailPlatform()
  const flow = await p.audience.getFlow(params.id).catch((err: unknown) => {
    if (err instanceof AudienceError) error(404, 'No such flow')
    throw err
  })
  const [lists, templates, senders, enrollments, log] = await Promise.all([
    p.audience.listLists(),
    p.templates.listTemplates(),
    p.owlery.isConfigured().then((ok) => (ok ? p.listSenders() : [])),
    p.audience.enrollments(flow.id),
    p.audience.flowLog(flow.id),
  ])
  const emailOf = new Map(enrollments.map((e) => [e.id, e.email]))
  return {
    flow: {
      id: flow.id,
      name: flow.name,
      status: flow.status,
      triggerListId: flow.triggerListId,
      steps: flow.parsedSteps,
    },
    lists: lists.map((l) => ({ id: l.id, name: l.name })),
    templates: templates.map((t) => ({ id: t.id, name: t.name })),
    senders: senders.map((s) => s.address),
    enrollments: enrollments.map((e) => ({
      id: e.id,
      email: e.email,
      status: e.status,
      stepIndex: e.stepIndex,
      waitUntil: e.waitUntil?.toISOString() ?? null,
    })),
    log: log.map((l) => ({
      id: l.id,
      event: l.event,
      stepId: l.stepId,
      email: emailOf.get(l.enrollmentId) ?? null,
      detail: l.detail,
      at: l.createdAt.toISOString(),
    })),
  }
}

export const actions: Actions = {
  save: async ({ locals, params, request }) => {
    await requireAdmin(locals)
    const form = await request.formData()
    return act('save', async () => {
      let steps: unknown
      try {
        steps = JSON.parse(field(form, 'steps') || '[]')
      } catch {
        throw new AudienceError('The steps could not be read; reload the page.')
      }
      await emailPlatform().audience.updateFlow(params.id, {
        name: field(form, 'name'),
        triggerListId: field(form, 'listId') || null,
        steps,
      })
      return {}
    })
  },
  status: async ({ locals, params, request }) => {
    await requireAdmin(locals)
    const status = field(await request.formData(), 'status')
    return act('status', async () => {
      if (status !== 'active' && status !== 'paused') throw new AudienceError('Unknown status.')
      return { status: (await emailPlatform().audience.setFlowStatus(params.id, status)).status }
    })
  },
  delete: async ({ locals, params }) => {
    await requireAdmin(locals)
    await emailPlatform().audience.deleteFlow(params.id)
    throw redirect(303, '/m/email/flows')
  },
}
