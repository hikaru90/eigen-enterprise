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
 * kernel.release_status is the read of Settings → Updates: it gives the exact
 * release name kernel.release_install takes, how the last update ended, and
 * what kernel.release_rollback would put back (plan/phase-upgrades.md §6.4).
 */

export const KERNEL_OPERATIONS_TOOL_NAMES = [
  'settings.logo_set',
  'settings.logo_recrop',
  'settings.logo_remove',
  'kernel.backup_run',
  'kernel.release_install',
  'kernel.release_status',
  'kernel.release_rollback',
] as const

/** The capabilities these tools check, as the routes do. */
export type OperationsCapability = 'company.manage' | 'backups.manage' | 'updates.manage' | 'owner'

/** A release name as ee requires it (ee/src/upgrade-job.ts RELEASE_NAME). */
export const RELEASE_NAME = /^eigenenterprise-\d+\.\d+\.\d+-[0-9a-f]{12}$/

/** Settings → Updates as data: what runs, the newest signed release, the last update. */
export type ReleaseStatus = {
  /** release is null when the running tarball has no release name (a hand-installed build). */
  installed: { release: string | null; tarball: string; version: string } | null
  /** Updated by its hosting provider: nothing to install from here. */
  managed: boolean
  /** null while an update runs, on a managed box, or when the lookup failed (latestError). */
  latest: { release: string; version: string; state: 'newer' | 'rebuild' | 'installed' | 'older'; notes: string | null } | null
  latestError: string | null
  job: { id: string; release: string; status: 'running' | 'succeeded' | 'failed'; step: string; error: string | null; endedAt: string | null } | null
  /** How the newest update ended (from here or from `ee upgrade` on the server); null when none is recorded. */
  lastOutcome: { release: string; from: string | null; step: string; ok: boolean; reason: string | null; rolledBack: boolean } | null
  /** What kernel.release_rollback would put back (`to`), or why it can't (`refused`); null on a managed box or while an update runs. */
  rollback: { to: string | null; refused: string | null } | null
}

export type LogoOutcome = { ok: true } | { ok: false; status: number; error: string }

export type OperationsPort = {
  /** Whether this person holds the capability ('owner': is the company owner). */
  can(userId: string, capability: OperationsCapability): Promise<boolean>
  setLogo(userId: string, input: { bytes: Uint8Array; mime: string; crop: unknown }): Promise<LogoOutcome>
  recropLogo(userId: string, crop: unknown): Promise<LogoOutcome>
  removeLogo(userId: string): Promise<void>
  /** Starts a backup now (ee runBackup, trigger manual); `author` is `human:<id>`. */
  runBackup(author: string): Promise<{ runId: string }>
  /** Settings → Updates' load (ee upgrade + latestRelease). */
  releaseStatus(): Promise<ReleaseStatus>
  /** Starts the update to `release` (ee startUpgrade); `author` is `human:<id>`. */
  installRelease(release: string, author: string): Promise<{ jobId: string; status: string }>
  /** Puts the release before back live (ee rollback); `to` picks one of the kept releases. */
  rollbackRelease(author: string, to?: string): Promise<{ from: string; to: string }>
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
const releaseInput = z
  .object({
    release: z
      .string()
      .regex(
        RELEASE_NAME,
        'release must be the full release name (eigenenterprise-<version>-<12-hex sha>), not a bare version: kernel.release_status gives it as latest.release',
      ),
  })
  .strict()

const rollbackInput = z
  .object({
    to: z
      .string()
      .regex(RELEASE_NAME, 'to must be the full release name (eigenenterprise-<version>-<12-hex sha>): kernel.release_status gives rollback.to')
      .optional(),
  })
  .strict()

const releaseStatusOutput = z.object({
  installed: z.object({ release: z.string().nullable(), tarball: z.string(), version: z.string() }).nullable(),
  managed: z.boolean(),
  latest: z
    .object({
      release: z.string(),
      version: z.string(),
      state: z.enum(['newer', 'rebuild', 'installed', 'older']),
      notes: z.string().nullable(),
    })
    .nullable(),
  latestError: z.string().nullable(),
  job: z
    .object({
      id: z.string(),
      release: z.string(),
      status: z.enum(['running', 'succeeded', 'failed']),
      step: z.string(),
      error: z.string().nullable(),
      endedAt: z.string().nullable(),
    })
    .nullable(),
  lastOutcome: z
    .object({
      release: z.string(),
      from: z.string().nullable(),
      step: z.string(),
      ok: z.boolean(),
      reason: z.string().nullable(),
      rolledBack: z.boolean(),
    })
    .nullable(),
  rollback: z.object({ to: z.string().nullable(), refused: z.string().nullable() }).nullable(),
})

const okSchema = z.object({ ok: z.literal(true) })

const REFUSED: Record<OperationsCapability, string> = {
  'company.manage': 'Only the owner or an admin can change the company logo.',
  'backups.manage': 'Only the owner can run a backup.',
  'updates.manage': 'Only the owner or an admin can see eigenEnterprise updates.',
  owner: 'Only the owner can install or roll back an eigenEnterprise release.',
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
        'Update this server to a newer signed eigenEnterprise release (Settings → Updates): ee checks the signature, takes a safety copy and deploys it health-gated. Owner only; waits for the owner’s approval. `release` is the full release name (eigenenterprise-<version>-<sha>) that kernel.release_status returns as latest.release.',
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
    {
      name: 'kernel.release_status',
      module: 'kernel',
      summary:
        'Read Settings → Updates: the eigenEnterprise release this server runs, the newest signed release (latest.release is the exact name kernel.release_install takes; state newer or rebuild means it can be installed), the last update with its step and error, how the newest update ended (lastOutcome: ok, the step, why, rolled back), and what kernel.release_rollback would put back (rollback.to, or rollback.refused). Owner or admin.',
      auditClass: 'read',
      inputSchema: z.object({}).strict(),
      outputSchema: releaseStatusOutput,
      permission: { roles: ['admin', 'agent'] },
      handler: async (ctx) => {
        await personWith(port, ctx, 'updates.manage')
        return port.releaseStatus()
      },
    },
    {
      name: 'kernel.release_rollback',
      module: 'kernel',
      summary:
        'Put the eigenEnterprise release that ran before back live (`ee rollback`): it is still installed on the server, so nothing is restored and no data is lost; ee brings it up health-gated and points the edge back at it. Refused below the downgrade floor of what runs now (that needs a restore). Owner only; waits for the owner’s approval. Without `to` it goes back to the release kernel.release_status names as rollback.to.',
      auditClass: 'mutate',
      approvalRisk: 'destructive',
      approvalAlways: true,
      activity: (input: { to?: string }) => `Rolled eigenEnterprise back${input.to ? ` to ${input.to}` : ' to the release before'}`,
      inputSchema: rollbackInput,
      outputSchema: z.object({ from: z.string(), to: z.string() }),
      permission: { roles: ['admin', 'agent'] },
      handler: async (ctx, input) => {
        const i = rollbackInput.parse(input)
        return port.rollbackRelease(`human:${await personWith(port, ctx, 'owner')}`, i.to)
      },
    },
  ]
}
