import type { ToolContext, ToolDescriptor } from './types'
import { z } from 'zod'
import { KernelError } from './errors'

/**
 * The company-level acts of Settings that are no allowlisted setting: the
 * company logo (Settings → Company: upload, re-crop, remove), a backup now
 * (Settings → Backups) and installing a new eigenEnterprise release
 * (Settings → Updates). Each tool calls the same service the page calls, as
 * the person behind the call with their own capability — never more — and
 * every one waits for the owner's approval whatever the approval mode
 * (approvalAlways), like settings.update.
 *
 * A call that runs as no person (a bare agent principal) is refused: these
 * pages are a person's capability (company.manage, backups.manage, owner).
 */

export const KERNEL_OPERATIONS_TOOL_NAMES = [
  'settings.logo_set',
  'settings.logo_recrop',
  'settings.logo_remove',
  'kernel.backup_run',
  'kernel.release_install',
] as const

/** The capabilities these tools check, as the routes do. */
export type OperationsCapability = 'company.manage' | 'backups.manage' | 'owner'

export type LogoOutcome = { ok: true } | { ok: false; status: number; error: string }

export type OperationsPort = {
  /** Whether this person holds the capability ('owner': is the company owner). */
  can(userId: string, capability: OperationsCapability): Promise<boolean>
  setLogo(userId: string, input: { bytes: Uint8Array; mime: string; crop: unknown }): Promise<LogoOutcome>
  recropLogo(userId: string, crop: unknown): Promise<LogoOutcome>
  removeLogo(userId: string): Promise<void>
  /** Starts a backup now (ee runBackup, trigger manual); `author` is `human:<id>`. */
  runBackup(author: string): Promise<{ runId: string }>
  /** Starts the update to `release` (ee startUpgrade); `author` is `human:<id>`. */
  installRelease(release: string, author: string): Promise<{ jobId: string; status: string }>
}

/** A square in the image's pixels (it may reach past the edges); cropLogo checks it against the image. */
const cropSchema = z.object({ left: z.number(), top: z.number(), size: z.number().positive() }).strict()

/** Base64 of at most 1 MB of bytes (the route's MAX_LOGO_BYTES; checkLogo checks the decoded size). */
const MAX_LOGO_BASE64 = Math.ceil((1024 * 1024) / 3) * 4 + 4

const logoSetInput = z
  .object({
    image_base64: z.string().min(1).max(MAX_LOGO_BASE64),
    mime: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml']),
    crop: cropSchema.optional(),
  })
  .strict()
const logoRecropInput = z.object({ crop: cropSchema }).strict()
const releaseInput = z.object({ release: z.string().min(1).max(100) }).strict()

const okSchema = z.object({ ok: z.literal(true) })

const REFUSED: Record<OperationsCapability, string> = {
  'company.manage': 'Only the owner or an admin can change the company logo.',
  'backups.manage': 'Only the owner can run a backup.',
  owner: 'Only the owner can install a new eigenEnterprise release.',
}

async function personWith(port: OperationsPort, ctx: ToolContext, capability: OperationsCapability): Promise<string> {
  if (ctx.principal.kind !== 'human') {
    throw new KernelError('no_person', 'This runs as a person (their own capability); this call runs as no person.')
  }
  if (!(await port.can(ctx.principal.id, capability))) throw new KernelError('permission_denied', REFUSED[capability])
  return ctx.principal.id
}

function logoDone(out: LogoOutcome): { ok: true } {
  if (!out.ok) throw new KernelError('invalid_input', out.error, { status: out.status })
  return { ok: true }
}

function decodeBase64(raw: string): Uint8Array {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(raw)) throw new KernelError('invalid_input', 'image_base64 is not base64.')
  return new Uint8Array(Buffer.from(raw, 'base64'))
}

export function createOperationsTools(deps: { port: OperationsPort }): ToolDescriptor[] {
  const { port } = deps
  return [
    {
      name: 'settings.logo_set',
      module: 'kernel',
      summary:
        'Upload the company logo (Settings → Company): the image as base64 with its type (PNG, JPEG, WebP or SVG, at most 1 MB). A PNG, JPEG or WebP needs `crop` — a square {left, top, size} in the image’s pixels; an SVG is kept as drawn. Waits for the owner’s approval.',
      auditClass: 'mutate',
      approvalRisk: 'internal',
      approvalAlways: true,
      activity: () => 'Changed the company logo',
      inputSchema: logoSetInput,
      outputSchema: okSchema,
      permission: { roles: ['admin', 'agent'] },
      handler: async (ctx, input) => {
        const i = logoSetInput.parse(input)
        const userId = await personWith(port, ctx, 'company.manage')
        return logoDone(await port.setLogo(userId, { bytes: decodeBase64(i.image_base64), mime: i.mime, crop: i.crop }))
      },
    },
    {
      name: 'settings.logo_recrop',
      module: 'kernel',
      summary:
        'Crop the company logo again from its kept original (a PNG, JPEG or WebP upload): `crop` is a square {left, top, size} in the original’s pixels. Waits for the owner’s approval.',
      auditClass: 'mutate',
      approvalRisk: 'internal',
      approvalAlways: true,
      activity: () => 'Cropped the company logo again',
      inputSchema: logoRecropInput,
      outputSchema: okSchema,
      permission: { roles: ['admin', 'agent'] },
      handler: async (ctx, input) => {
        const i = logoRecropInput.parse(input)
        const userId = await personWith(port, ctx, 'company.manage')
        return logoDone(await port.recropLogo(userId, i.crop))
      },
    },
    {
      name: 'settings.logo_remove',
      module: 'kernel',
      summary: 'Remove the company logo (the app shows the company’s initial again). Waits for the owner’s approval.',
      auditClass: 'mutate',
      approvalRisk: 'internal',
      approvalAlways: true,
      activity: () => 'Removed the company logo',
      inputSchema: z.object({}).strict(),
      outputSchema: okSchema,
      permission: { roles: ['admin', 'agent'] },
      handler: async (ctx) => {
        await port.removeLogo(await personWith(port, ctx, 'company.manage'))
        return { ok: true as const }
      },
    },
    {
      name: 'kernel.backup_run',
      module: 'kernel',
      summary:
        'Start a backup of the whole company now (Settings → Backups, “Back up now”), to the bucket the owner set up. Owner only; waits for the owner’s approval. Returns the run id; substrate.backup_status shows how it went.',
      auditClass: 'mutate',
      approvalRisk: 'internal',
      approvalAlways: true,
      activity: () => 'Started a backup',
      inputSchema: z.object({}).strict(),
      outputSchema: z.object({ runId: z.string() }),
      permission: { roles: ['admin', 'agent'] },
      handler: async (ctx) => port.runBackup(`human:${await personWith(port, ctx, 'backups.manage')}`),
    },
    {
      name: 'kernel.release_install',
      module: 'kernel',
      summary:
        'Update this server to a newer signed eigenEnterprise release (Settings → Updates): ee checks the signature, takes a safety copy and deploys it health-gated. Owner only; waits for the owner’s approval. `release` is the version Settings → Updates offers.',
      auditClass: 'mutate',
      approvalRisk: 'destructive',
      approvalAlways: true,
      activity: (input: { release: string }) => `Started the update to eigenEnterprise ${input.release}`,
      inputSchema: releaseInput,
      outputSchema: z.object({ jobId: z.string(), status: z.string() }),
      permission: { roles: ['admin', 'agent'] },
      handler: async (ctx, input) => {
        const i = releaseInput.parse(input)
        return port.installRelease(i.release, `human:${await personWith(port, ctx, 'owner')}`)
      },
    },
  ]
}
