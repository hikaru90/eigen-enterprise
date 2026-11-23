import type { Actions, PageServerLoad } from './$types'
import { fail } from '@sveltejs/kit'
import { KernelError } from '$lib/kernel/errors'
import type { CompanyExportView, ExportPort } from '$lib/kernel/export-tools'
import { requireCapability } from '$lib/server/auth/require-capability'
import { errorReport, refusalReport } from '$lib/server/errors/report'

/**
 * Settings → Export (plan/phase-export.md X1): the owner exports everything the
 * company owns as one zip in open formats, watches it being built, downloads
 * it, and sees the past exports. The same service as kernel.export_company /
 * export_list / export_delete (the CLI and the agent use those); the owner
 * clicking is the decision, like Settings → Backups.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Overridable in tests; loaded on use (the live port opens the database on import). */
export const _exportDeps = {
  port: async (): Promise<ExportPort> => (await import('$lib/server/export/company/live')).liveExportPort,
}

async function requireOwner(locals: App.Locals): Promise<string> {
  const { user } = await requireCapability(locals, 'export.manage', 'Only the owner can export the company.')
  return user.id
}

export const load: PageServerLoad = async ({ locals }): Promise<{ exports: CompanyExportView[] }> => {
  await requireOwner(locals)
  return { exports: await (await _exportDeps.port()).list() }
}

function refused(action: string, err: unknown, attempted: string) {
  if (err instanceof KernelError && (err.code === 'run_in_progress' || err.code === 'invalid_input')) {
    return fail(err.code === 'run_in_progress' ? 409 : 404, {
      action,
      ...refusalReport(err.message, { attempted, nextSteps: ['Reload Settings → Export to see the current state.'] }),
    })
  }
  return fail(500, {
    action,
    ...errorReport(err, {
      attempted,
      plain: (e) => (e as Error).message,
      nextSteps: ['Read the app log on the server ([company-export] lines); kernel.export_company on the CLI does the same.'],
    }),
  })
}

export const actions: Actions = {
  start: async ({ locals }) => {
    const userId = await requireOwner(locals)
    try {
      return { action: 'start', ok: true as const, export: await (await _exportDeps.port()).start(userId) }
    } catch (err) {
      return refused('start', err, 'Starting a company export (Settings → Export)')
    }
  },
  delete: async ({ locals, request }) => {
    await requireOwner(locals)
    const id = ((await request.formData()).get('id') ?? '').toString()
    try {
      if (!UUID.test(id)) throw new KernelError('invalid_input', `No company export ${id || '(none given)'}.`)
      const done = await (await _exportDeps.port()).remove(id)
      if (!done) throw new KernelError('invalid_input', `No company export ${id}.`)
      return { action: 'delete', ok: true as const }
    } catch (err) {
      return refused('delete', err, 'Deleting a company export (Settings → Export)')
    }
  },
}
