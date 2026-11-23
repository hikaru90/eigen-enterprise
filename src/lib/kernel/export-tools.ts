import type { ToolContext, ToolDescriptor } from './types'
import { z } from 'zod'
import { KernelError } from './errors'

/**
 * The company export (plan/phase-export.md X1): "export everything the company
 * owns". Owner only. Starting one waits for the owner's approval whatever the
 * approval mode, because the whole company leaves the system as a file. Settings →
 * Export is a client of these tools; the CLI and the agent get the same.
 */

export const KERNEL_EXPORT_TOOL_NAMES = [
  'kernel.export_company',
  'kernel.export_status',
  'kernel.export_list',
  'kernel.export_delete',
] as const

export type CompanyExportView = {
  id: string
  status: 'pending' | 'running' | 'done' | 'failed' | 'deleted'
  requestedBy: string
  createdAt: string
  finishedAt: string | null
  expiresAt: string | null
  bytes: number | null
  summary: { tables: number; rows: number; privateRows: number; files: number; excluded: number } | null
  error: string | null
  /** Where the owner downloads it (signed in), only while `done` and not expired. */
  downloadPath: string | null
}

export type ExportPort = {
  isOwner(userId: string): Promise<boolean>
  /** Records the export and queues the job that builds it. */
  start(userId: string): Promise<CompanyExportView>
  get(id: string): Promise<CompanyExportView | null>
  list(): Promise<CompanyExportView[]>
  /** Deletes the archive from disk; the row stays as `deleted` (the history shows it existed). */
  remove(id: string): Promise<CompanyExportView | null>
}

const viewSchema = z.object({
  id: z.string(),
  status: z.enum(['pending', 'running', 'done', 'failed', 'deleted']),
  requestedBy: z.string(),
  createdAt: z.string(),
  finishedAt: z.string().nullable(),
  expiresAt: z.string().nullable(),
  bytes: z.number().nullable(),
  summary: z
    .object({ tables: z.number(), rows: z.number(), privateRows: z.number(), files: z.number(), excluded: z.number() })
    .nullable(),
  error: z.string().nullable(),
  downloadPath: z.string().nullable(),
})
const idInput = z.object({ id: z.string().uuid() }).strict()

async function owner(port: ExportPort, ctx: ToolContext): Promise<string> {
  if (ctx.principal.kind !== 'human') {
    throw new KernelError('no_person', 'This runs as a person (the owner); this call runs as no person.')
  }
  if (!(await port.isOwner(ctx.principal.id))) {
    throw new KernelError('permission_denied', 'Only the owner can export the company.')
  }
  return ctx.principal.id
}

async function found(p: Promise<CompanyExportView | null>, id: string): Promise<CompanyExportView> {
  const v = await p
  if (!v) throw new KernelError('invalid_input', `No company export ${id}.`)
  return v
}

export function createExportTools(deps: { port: ExportPort }): ToolDescriptor[] {
  const { port } = deps
  return [
    {
      name: 'kernel.export_company',
      module: 'kernel',
      summary:
        'Export everything the company owns as one zip in open formats (Settings → Export): every table as JSON Lines, every company file, a README and a manifest with checksums. A member’s private items are in it as metadata only (whose, when, with whom), never their content; secrets are never exported. Owner only; waits for the owner’s approval. Returns the export; kernel.export_status shows progress and the download.',
      auditClass: 'mutate',
      approvalRisk: 'external',
      approvalAlways: true,
      activity: () => 'Started a company export',
      inputSchema: z.object({}).strict(),
      outputSchema: viewSchema,
      permission: { roles: ['admin', 'agent'] },
      handler: async (ctx) => port.start(await owner(port, ctx)),
    },
    {
      name: 'kernel.export_status',
      module: 'kernel',
      summary: 'One company export: its status, size, what it holds, and the download path once it is done. Owner only.',
      auditClass: 'read',
      inputSchema: idInput,
      outputSchema: viewSchema,
      permission: { roles: ['admin', 'agent'] },
      handler: async (ctx, input) => {
        const { id } = idInput.parse(input)
        await owner(port, ctx)
        return found(port.get(id), id)
      },
    },
    {
      name: 'kernel.export_list',
      module: 'kernel',
      summary: 'The company exports, newest first (Settings → Export history). Owner only.',
      auditClass: 'read',
      inputSchema: z.object({}).strict(),
      outputSchema: z.object({ exports: z.array(viewSchema) }),
      permission: { roles: ['admin', 'agent'] },
      handler: async (ctx) => {
        await owner(port, ctx)
        return { exports: await port.list() }
      },
    },
    {
      name: 'kernel.export_delete',
      module: 'kernel',
      summary: 'Delete a company export’s archive from the server now (it is deleted after 7 days anyway). The history keeps the entry. Owner only.',
      auditClass: 'mutate',
      approvalRisk: 'destructive',
      activity: () => 'Deleted a company export',
      inputSchema: idInput,
      outputSchema: viewSchema,
      permission: { roles: ['admin', 'agent'] },
      handler: async (ctx, input) => {
        const { id } = idInput.parse(input)
        await owner(port, ctx)
        return found(port.remove(id), id)
      },
    },
  ]
}
