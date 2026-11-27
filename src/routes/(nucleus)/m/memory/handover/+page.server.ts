import type { Actions, PageServerLoad } from './$types'
import { randomUUID } from 'node:crypto'
import { error, fail, redirect } from '@sveltejs/kit'
import { KernelError } from '$lib/kernel/errors'
import { getUserRole, kernelRolesFor } from '$lib/server/auth/user-role'
import { appKernel } from '$lib/server/boot'
import { errorReport, refusalReport } from '$lib/server/errors/report'
import { handoverDeps } from '$lib/server/memory/handover/live'
import { HandoverError, handoverBoard } from '$lib/server/memory/handover/service'

/**
 * Memory › Handover (plan/handover.md, Contribute b92e6ba5): every handover in
 * the company — "Handover to Alex", a topic — with its entries newest first:
 * day, topic, one sentence, status, link. Every member reads them all; the
 * owner adds, changes, assigns and removes entries. Every form runs the
 * handover.* registry tool as the signed-in person with their own kernel
 * roles: the page is a client of the registry, the same tools the assistant
 * and the CLI use.
 */

function signedIn(locals: App.Locals): string {
  if (!locals.user) throw redirect(302, '/login')
  return locals.user.id
}

export const load: PageServerLoad = async ({ locals }) => {
  const userId = signedIn(locals)
  const deps = await handoverDeps()
  try {
    const handovers = await handoverBoard(deps, userId)
    const members = (await deps.directory.list()).map((p) => ({ id: p.id, name: p.name }))
    return { handovers, members, userId }
  } catch (err) {
    if (err instanceof HandoverError && err.code === 'forbidden') error(403, err.message)
    throw err
  }
}

const text = (form: FormData, key: string): string | undefined => {
  const v = form.get(key)
  return typeof v === 'string' ? v : undefined
}
/** An optional field left empty is left out (the tool keeps its default). */
const filled = (form: FormData, key: string) => {
  const v = text(form, key)?.trim()
  return v ? v : undefined
}

const STATUS_OF: Record<HandoverError['code'], number> = { invalid: 400, not_found: 404, forbidden: 403, conflict: 409 }

/** Runs a handover.* tool as the person; `formId` names the form a refusal belongs to ('new', 'add-<handover>', or an entry id). */
async function run(userId: string, formId: string, tool: string, input: Record<string, unknown>) {
  const attempted = `Running ${tool} from /m/memory/handover`
  const role = await getUserRole(userId)
  if (!role) return fail(403, { formId, ...refusalReport('Only a member of this company keeps handovers here.', { attempted, tool, input }) })
  try {
    const kernel = await appKernel()
    await kernel.registry.execute(tool, input, {
      principal: { id: userId, kind: 'human', roles: kernelRolesFor(role) },
      requestId: randomUUID(),
    })
    return { formId, ok: true as const }
  } catch (err) {
    const report = () => errorReport(err, { attempted, tool, input, plain: (e) => (e instanceof Error ? e.message : String(e)) })
    if (err instanceof HandoverError) return fail(STATUS_OF[err.code], { formId, ...report() })
    if (err instanceof KernelError && err.code === 'invalid_input') return fail(400, { formId, ...report() })
    throw err
  }
}

export const actions: Actions = {
  create: async ({ locals, request }) => {
    const form = await request.formData()
    return run(signedIn(locals), 'new', 'handover.create', {
      title: text(form, 'title') ?? '',
      subject_id: filled(form, 'subject_id'),
    })
  },
  add: async ({ locals, request }) => {
    const form = await request.formData()
    const handoverId = text(form, 'handover_id') ?? ''
    return run(signedIn(locals), `add-${handoverId}`, 'handover.add_entry', {
      handover_id: handoverId,
      topic: text(form, 'topic') ?? '',
      sentence: text(form, 'sentence') ?? '',
      status: text(form, 'status') ?? '',
      link: filled(form, 'link'),
    })
  },
  update: async ({ locals, request }) => {
    const form = await request.formData()
    const entryId = text(form, 'entry_id') ?? ''
    return run(signedIn(locals), entryId, 'handover.update_entry', {
      entry_id: entryId,
      topic: text(form, 'topic'),
      sentence: text(form, 'sentence'),
      status: text(form, 'status'),
      // An emptied link field removes the link.
      link: filled(form, 'link') ?? null,
    })
  },
  assign: async ({ locals, request }) => {
    const form = await request.formData()
    const entryId = text(form, 'entry_id') ?? ''
    return run(signedIn(locals), entryId, 'handover.assign_entry', { entry_id: entryId, assignee_id: text(form, 'assignee_id') ?? '' })
  },
  remove: async ({ locals, request }) => {
    const entryId = text(await request.formData(), 'entry_id') ?? ''
    return run(signedIn(locals), entryId, 'handover.remove_entry', { entry_id: entryId })
  },
  remove_handover: async ({ locals, request }) => {
    const handoverId = text(await request.formData(), 'handover_id') ?? ''
    return run(signedIn(locals), handoverId, 'handover.delete', { handover_id: handoverId })
  },
}
