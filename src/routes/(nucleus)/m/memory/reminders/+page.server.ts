import type { Actions, PageServerLoad } from './$types'
import { randomUUID } from 'node:crypto'
import { fail, redirect } from '@sveltejs/kit'
import { KernelError } from '$lib/kernel/errors'
import { getUserRole, kernelRolesFor } from '$lib/server/auth/user-role'
import { appKernel } from '$lib/server/boot'
import { errorReport, refusalReport } from '$lib/server/errors/report'
import { reminderDeps } from '$lib/server/memory/reminders/live'
import { listReminders, ReminderError } from '$lib/server/memory/reminders/service'

/**
 * Memory › Reminders: the person's own recurring reminders (Contribute
 * 2c414719) — create, change, pause, resume, delete; tick off or snooze a due
 * one (the dashboard's Needs you posts here too). Every form runs the
 * reminders.* registry tool as the signed-in person with their own kernel
 * roles: the page is a client of the registry, the same tools the assistant
 * and the CLI use.
 */

function signedIn(locals: App.Locals): string {
  if (!locals.user) throw redirect(302, '/login')
  return locals.user.id
}

export const load: PageServerLoad = async ({ locals }) => {
  const userId = signedIn(locals)
  const deps = await reminderDeps()
  return { reminders: await listReminders(deps, userId), timeZone: await deps.timeZoneOf(userId) }
}

const text = (form: FormData, key: string): string | undefined => {
  const v = form.get(key)
  return typeof v === 'string' ? v : undefined
}
/** An optional field left empty is left out (the tool keeps the current value or its default). */
const filled = (form: FormData, key: string) => {
  const v = text(form, key)?.trim()
  return v ? v : undefined
}
const idOf = (form: FormData) => text(form, 'reminder_id') ?? ''

async function run(
  userId: string,
  reminderId: string,
  tool: string,
  input: Record<string, unknown>,
) {
  const attempted = `Running ${tool} from /m/memory/reminders`
  const role = await getUserRole(userId)
  if (!role)
    return fail(403, {
      reminderId,
      ...refusalReport('Only a member of this company keeps reminders here.', {
        attempted,
        tool,
        input,
      }),
    })
  try {
    const kernel = await appKernel()
    await kernel.registry.execute(tool, input, {
      principal: { id: userId, kind: 'human', roles: kernelRolesFor(role) },
      requestId: randomUUID(),
    })
    return { reminderId, ok: true as const }
  } catch (err) {
    const report = () =>
      errorReport(err, {
        attempted,
        tool,
        input,
        plain: (e) => (e instanceof Error ? e.message : String(e)),
      })
    if (err instanceof ReminderError)
      return fail(err.code === 'not_found' ? 404 : err.code === 'conflict' ? 409 : 400, {
        reminderId,
        ...report(),
      })
    if (err instanceof KernelError && err.code === 'invalid_input')
      return fail(400, { reminderId, ...report() })
    throw err
  }
}

export const actions: Actions = {
  create: async ({ locals, request }) => {
    const userId = signedIn(locals)
    const form = await request.formData()
    return run(userId, 'new', 'reminders.create', {
      title: text(form, 'title') ?? '',
      note: filled(form, 'note'),
      weekdays: form.getAll('weekdays'),
      time: text(form, 'time') ?? '',
      time_zone: filled(form, 'time_zone'),
    })
  },
  update: async ({ locals, request }) => {
    const userId = signedIn(locals)
    const form = await request.formData()
    const id = idOf(form)
    return run(userId, id, 'reminders.update', {
      reminder_id: id,
      title: text(form, 'title'),
      note: text(form, 'note'),
      weekdays: form.getAll('weekdays'),
      time: text(form, 'time'),
      time_zone: filled(form, 'time_zone'),
    })
  },
  pause: async ({ locals, request }) => {
    const id = idOf(await request.formData())
    return run(signedIn(locals), id, 'reminders.pause', { reminder_id: id })
  },
  resume: async ({ locals, request }) => {
    const id = idOf(await request.formData())
    return run(signedIn(locals), id, 'reminders.resume', { reminder_id: id })
  },
  delete: async ({ locals, request }) => {
    const id = idOf(await request.formData())
    return run(signedIn(locals), id, 'reminders.delete', { reminder_id: id })
  },
  complete: async ({ locals, request }) => {
    const form = await request.formData()
    const id = idOf(form)
    return run(signedIn(locals), id, 'reminders.complete', {
      reminder_id: id,
      ...(text(form, 'all') === '1' ? { all: true } : {}),
    })
  },
  snooze: async ({ locals, request }) => {
    const form = await request.formData()
    const id = idOf(form)
    return run(signedIn(locals), id, 'reminders.snooze', {
      reminder_id: id,
      minutes: Number(text(form, 'minutes')),
    })
  },
}
