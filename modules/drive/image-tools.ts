import type { DriveService } from './service'
import { z } from 'zod'
import { KernelError } from '$lib/kernel/errors'
import type { ToolDescriptor } from '$lib/kernel/types'
import { isLlmNotConfiguredError } from '$lib/server/llm/errors'
import type { ChatAttachment } from '$lib/server/llm/llm-client'
import { detectImageMime, isPdfBytes, VisionReadError, type llmLookAt } from '$lib/server/llm/vision'
import { DRIVE_MODULE_ID } from './manifest'
import { actorOf } from './tools'

/**
 * drive.view_image — looking at an image (or a PDF's pages as they look) in Drive (wish a4a5a3ad:
 * "PNGs in Drive give 'is not a text file'"). The file is read as the caller (the same access as
 * opening it) and handed to a vision model through the gateway (vision.ts), so a co-worker or the
 * assistant sees it even when the company's chat model reads text only. Images posted in a chat
 * conversation are Drive files too (the conversation's folder), so this is how they are seen.
 */

/** The largest file that is looked at (a vision request carries it inline). */
export const DRIVE_VIEW_MAX_BYTES = 10 * 1024 * 1024

const DRIVE_ROLES = ['admin', 'member', 'agent']

const viewInput = z
  .object({
    file_id: z.string().min(1),
    question: z.string().max(2000).optional(),
  })
  .strict()

export type DriveImageToolDeps = {
  service: () => Promise<DriveService>
  lookAt?: () => Promise<typeof llmLookAt>
}

const liveLookAt = async () => (await import('$lib/server/llm/vision')).llmLookAt

export function createDriveImageTools(deps: DriveImageToolDeps): ToolDescriptor[] {
  const lookAt = deps.lookAt ?? liveLookAt
  return [
    {
      name: 'drive.view_image',
      module: DRIVE_MODULE_ID,
      summary:
        'Look at an image (PNG, JPEG, WebP) or a PDF in Drive by file_id: its text and a description of what it shows, from a vision model (question: what to look for or answer). Use it for pictures, screenshots, designs and scans that drive.read cannot read as text. At most 10 MB.',
      auditClass: 'read',
      inputSchema: viewInput,
      permission: { roles: DRIVE_ROLES },
      handler: async (ctx, input) => {
        const i = viewInput.parse(input)
        const { file, bytes } = await (await deps.service()).readFile(actorOf(ctx), i.file_id)
        if (bytes.length > DRIVE_VIEW_MAX_BYTES) {
          throw new KernelError('invalid_input', `“${file.name}” is ${(bytes.length / 1024 / 1024).toFixed(1)} MB; an image or PDF can be looked at up to 10 MB.`)
        }
        const mime = detectImageMime(bytes)
        if (!mime && !isPdfBytes(bytes)) {
          throw new KernelError('invalid_input', `“${file.name}” is not an image (PNG, JPEG, WebP) or a PDF; read text files with drive.read.`)
        }
        const base64 = Buffer.from(bytes).toString('base64')
        const attachment: ChatAttachment = mime ? { type: 'image', mime, base64 } : { type: 'pdf', filename: file.name, base64 }
        try {
          const seen = await (await lookAt())({
            userId: ctx.principal.id,
            task: 'drive.image_read',
            name: file.name,
            attachment,
            ...(i.question ? { question: i.question } : {}),
          })
          return { file_id: file.id, name: file.name, kind: mime ? 'image' : 'pdf', text: seen.text }
        } catch (err) {
          if (err instanceof VisionReadError) throw new KernelError('invalid_input', err.message)
          if (isLlmNotConfiguredError(err)) throw new KernelError('not_configured', (err as Error).message)
          throw err
        }
      },
    },
  ]
}
