import type { Actor, DriveService } from './service'
import { z } from 'zod'
import type { ToolContext, ToolDescriptor } from '$lib/kernel/types'
import { DRIVE_MODULE_ID } from './manifest'

/**
 * drive.* kernel tools: list a folder, read a text file, write a Markdown/CSV
 * file (a new revision). Every call runs through the Drive service's access
 * checks as the calling principal: a person with their own access, the agent
 * with admin rights (like members.*). Writing is mutate-class and waits on
 * the company's approval mode.
 */

export type DriveToolDeps = { service?: () => Promise<DriveService> }

const listInput = z.object({ folder_id: z.string().min(1).nullable().optional() }).strict()
const readInput = z.object({ file_id: z.string().min(1) }).strict()
const writeInput = z.object({ file_id: z.string().min(1), content: z.string() }).strict()

export function actorOf(ctx: ToolContext): Actor {
  return ctx.principal.kind === 'human' ? { kind: 'user', userId: ctx.principal.id } : { kind: 'agent', id: ctx.principal.id }
}

async function liveService(): Promise<DriveService> {
  const { driveService } = await import('./index')
  return driveService()
}

export function createDriveTools(opts: DriveToolDeps = {}): ToolDescriptor[] {
  const service = opts.service ?? liveService
  return [
    {
      name: 'drive.list',
      module: DRIVE_MODULE_ID,
      summary: 'List a Drive folder (folder_id; omit for the top level): its folders and files with ids, names, sizes and types.',
      auditClass: 'read',
      inputSchema: listInput,
      permission: { roles: ['admin', 'agent'] },
      handler: async (ctx, input) => {
        const i = listInput.parse(input)
        const out = await (await service()).listFolder(actorOf(ctx), i.folder_id ?? null)
        return { folder: out.folder, path: out.path, items: out.items }
      },
    },
    {
      name: 'drive.read',
      module: DRIVE_MODULE_ID,
      summary: 'Read a text file from Drive (Markdown, CSV, plain text) by file_id.',
      auditClass: 'read',
      inputSchema: readInput,
      permission: { roles: ['admin', 'agent'] },
      handler: async (ctx, input) => (await service()).readText(actorOf(ctx), readInput.parse(input).file_id),
    },
    {
      name: 'drive.write_text',
      module: DRIVE_MODULE_ID,
      summary: 'Replace the text of a Markdown (.md) or table (.csv) file in Drive. Every write is kept as a revision that can be restored.',
      auditClass: 'mutate',
      approvalRisk: 'internal',
      activity: (input: z.infer<typeof writeInput>, output: unknown) => {
        const name = (output as { file?: { name?: string } } | undefined)?.file?.name
        return name ? `Saved a new version of ${name} in Drive` : `Tried to save file ${input.file_id} in Drive`
      },
      inputSchema: writeInput,
      permission: { roles: ['admin', 'agent'] },
      handler: async (ctx, input) => {
        const i = writeInput.parse(input)
        const out = await (await service()).writeText(actorOf(ctx), i.file_id, i.content)
        return { file: out.file, revision: { id: out.revision.id, createdAt: out.revision.createdAt } }
      },
    },
  ]
}
