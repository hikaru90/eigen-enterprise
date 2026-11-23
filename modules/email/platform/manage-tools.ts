import type { EmailPlatform } from './service'
import { z } from 'zod'
import type { BoughtDomain } from '$lib/domains/contract'
import type { ToolDescriptor } from '$lib/kernel/types'
import { CONTACT_STATUSES } from '$lib/server/db/email-contacts.schema'
import { EMAIL_MODULE_ID } from '../manifest'
import { EmailPlatformError } from './service'

/**
 * UI parity for the Email pages (src/lib/kernel/ui-parity.ts): every change the
 * Email › Domains, Layouts, Templates, Marketing, Senders and Setup pages make,
 * as a registry tool calling the same service method with the same arguments.
 * The caller acts as themselves (ROLES = the pages' admin gate); every change
 * waits on the approval gate (EMAIL_PLATFORM_WRITE_TOOLS).
 */

export type EmailManageToolDeps = {
  platform?: () => EmailPlatform
  /** This server's absolute origin (the pages pass url.origin); production reads ORIGIN. */
  origin?: () => Promise<string>
  /** A member's sign-in address (the template test goes there); null for a non-member principal. */
  memberEmail?: (userId: string) => Promise<string | null>
  /** The company's bought domains (managed box); production asks the domains API, [] without one. */
  bought?: () => Promise<BoughtDomain[]>
}

const ROLES = { roles: ['admin', 'agent'] }

/** The route's limit: the os request body (ee/src/body-limit.ts OS_BODY_SIZE_LIMIT, 110M). */
export const LIST_IMPORT_MAX_CHARS = 110 * 1024 * 1024

async function envOrigin(): Promise<string> {
  const { env } = await import('$env/dynamic/private')
  const { siteOrigin } = await import('../../website/site-info')
  return siteOrigin(env.ORIGIN)
}

async function dbMemberEmail(userId: string): Promise<string | null> {
  const { eq } = await import('drizzle-orm')
  const { authDb } = await import('$lib/server/db/auth-db')
  const { user } = await import('$lib/server/db/auth.schema')
  const [row] = await authDb.select({ email: user.email }).from(user).where(eq(user.id, userId)).limit(1)
  return row?.email ?? null
}

async function liveBought(): Promise<BoughtDomain[]> {
  const { domainsFromEnv } = await import('$lib/server/domains/env')
  const { domainsClient } = await import('$lib/server/domains/client')
  const config = domainsFromEnv()
  return config ? domainsClient(config).list() : []
}

export function createEmailManageTools(deps: EmailManageToolDeps = {}): ToolDescriptor[] {
  const platform = async (): Promise<EmailPlatform> => {
    if (deps.platform) return deps.platform()
    const { emailPlatform } = await import('./service')
    return emailPlatform()
  }
  const origin = deps.origin ?? envOrigin
  const memberEmail = deps.memberEmail ?? dbMemberEmail
  const bought = deps.bought ?? liveBought

  const byId = z.object({ id: z.uuid() }).strict()
  const onOff = z.object({ id: z.uuid(), on: z.boolean() }).strict()
  const named = z.object({ name: z.string().min(1).max(200) }).strict()
  const layoutSave = z.object({ id: z.uuid(), name: z.string().min(1).max(200), format: z.enum(['mjml', 'html']), body: z.string() }).strict()
  const templateCreate = z.object({ name: z.string().min(1).max(200), layoutId: z.uuid().optional() }).strict()
  const templateDraft = z
    .object({
      id: z.uuid(),
      name: z.string().min(1).max(200),
      subject: z.string(),
      format: z.enum(['mjml', 'html']),
      body: z.string(),
      textBody: z.string().optional(),
      layoutId: z.uuid().optional(),
      sampleVariables: z.record(z.string(), z.string()).default({}),
    })
    .strict()
  const flowCreate = z.object({ name: z.string().min(1).max(200), listId: z.uuid().optional() }).strict()
  const flowSave = z.object({ id: z.uuid(), name: z.string().min(1).max(200), listId: z.uuid().optional(), steps: z.array(z.unknown()) }).strict()
  const flowStatus = z.object({ id: z.uuid(), status: z.enum(['active', 'paused']) }).strict()
  const listCreate = z.object({ name: z.string().min(1).max(200), doubleOptIn: z.boolean().default(false) }).strict()
  const listSave = z
    .object({
      id: z.uuid(),
      name: z.string().min(1).max(200),
      description: z.string().max(2000).optional(),
      doubleOptIn: z.boolean(),
      publicSignup: z.boolean(),
    })
    .strict()
  const listImport = z.object({ listId: z.uuid(), csv: z.string().min(1).max(LIST_IMPORT_MAX_CHARS) }).strict()
  const listContacts = z.object({ listId: z.uuid(), status: z.enum(CONTACT_STATUSES).optional() }).strict()
  const senderAddress = z.object({ address: z.string().trim().toLowerCase().pipe(z.email()) }).strict()
  const none = z.object({}).strict()

  const draftOf = (p: z.infer<typeof templateDraft>) => ({
    name: p.name,
    subject: p.subject,
    format: p.format,
    body: p.body,
    textBody: p.textBody || null,
    layoutId: p.layoutId ?? null,
    sampleVariables: p.sampleVariables,
  })

  const senderId = async (address: string): Promise<string> => {
    const s = await (await platform()).store.getSenderByAddress(address)
    if (!s) throw new EmailPlatformError(`${address} is not one of the senders (email.sender_list).`)
    return s.id
  }

  const write = (
    t: Omit<ToolDescriptor, 'module' | 'auditClass' | 'approvalRisk' | 'permission'> & { destructive?: boolean },
  ): ToolDescriptor => {
    const { destructive, ...rest } = t
    return { ...rest, module: EMAIL_MODULE_ID, auditClass: 'mutate', approvalRisk: destructive ? 'destructive' : 'internal', permission: ROLES }
  }

  return [
    // ── Domains ────────────────────────────────────────────────────────────
    write({
      name: 'email.domain_delete',
      summary: 'Remove a sender domain (also at Amazon SES). Refused while mailbox addresses still use it.',
      destructive: true,
      activity: () => 'Removed a sender domain',
      inputSchema: byId,
      handler: async (_ctx, input) => {
        const { id } = byId.parse(input)
        await (await platform()).deleteDomain(id)
        return { id, removed: true }
      },
    }),
    write({
      name: 'email.domain_set_receiving',
      summary:
        "Receive mail on a verified domain (on) or stop (off). Turning it on means the domain's MX records must point at Amazon, so mail goes to the company's mailboxes. The first domain also sets receiving up at Amazon.",
      activity: (input: z.infer<typeof onOff>) => `Turned receiving mail ${input.on ? 'on' : 'off'} for a domain`,
      inputSchema: onOff,
      handler: async (_ctx, input) => {
        const p = onOff.parse(input)
        const out = await (await platform()).setDomainReceiving(p.id, p.on, await origin())
        return { receiving: out.domain.receiving, receivingError: out.receivingError }
      },
    }),
    write({
      name: 'email.domain_set_tracking',
      summary: 'Open and click tracking for mail sent from a domain, on or off.',
      activity: (input: z.infer<typeof onOff>) => `Turned open/click tracking ${input.on ? 'on' : 'off'} for a domain`,
      inputSchema: onOff,
      handler: async (_ctx, input) => {
        const p = onOff.parse(input)
        return { tracking: (await (await platform()).setDomainTracking(p.id, p.on)).tracking }
      },
    }),

    // ── Layouts ────────────────────────────────────────────────────────────
    write({
      name: 'email.layout_create',
      summary: 'Create a mail layout (the brand wrapper templates render inside), started from the brand.',
      activity: (input: z.infer<typeof named>) => `Created the mail layout ${input.name}`,
      inputSchema: named,
      handler: async (ctx, input) => ({
        id: (await (await platform()).templates.createLayout(named.parse(input).name, ctx.principal.id)).id,
      }),
    }),
    write({
      name: 'email.layout_update',
      summary: 'Save a mail layout: name, format (mjml|html) and source with its {{ content }} slot.',
      activity: (input: z.infer<typeof layoutSave>) => `Saved the mail layout ${input.name}`,
      inputSchema: layoutSave,
      handler: async (_ctx, input) => {
        const p = layoutSave.parse(input)
        await (await platform()).templates.updateLayout(p.id, { name: p.name, format: p.format, body: p.body })
        return { id: p.id, saved: true }
      },
    }),
    write({
      name: 'email.layout_delete',
      summary: 'Delete a mail layout. Refused while templates use it.',
      destructive: true,
      activity: () => 'Deleted a mail layout',
      inputSchema: byId,
      handler: async (_ctx, input) => {
        const { id } = byId.parse(input)
        await (await platform()).templates.deleteLayout(id)
        return { id, removed: true }
      },
    }),

    // ── Templates ──────────────────────────────────────────────────────────
    write({
      name: 'email.template_create',
      summary: 'Create a mail template (optionally inside a layout). Edit it with email.template_update.',
      activity: (input: z.infer<typeof templateCreate>) => `Created the mail template ${input.name}`,
      inputSchema: templateCreate,
      handler: async (ctx, input) => {
        const p = templateCreate.parse(input)
        const t = await (await platform()).templates.createTemplate({ name: p.name, layoutId: p.layoutId ?? null }, ctx.principal.id)
        return { id: t.id }
      },
    }),
    write({
      name: 'email.template_update',
      summary: 'Save a mail template: name, subject, format (mjml|html), body, optional text body and layout, sample variable values.',
      activity: (input: z.infer<typeof templateDraft>) => `Saved the mail template ${input.name}`,
      inputSchema: templateDraft,
      handler: async (_ctx, input) => {
        const p = templateDraft.parse(input)
        await (await platform()).templates.updateTemplate(p.id, draftOf(p))
        return { id: p.id, saved: true }
      },
    }),
    write({
      name: 'email.template_send_test',
      summary: "Save the template draft, then send it with its sample values to the calling person's own sign-in address (never anyone else).",
      activity: () => 'Sent myself a test of a mail template',
      inputSchema: templateDraft,
      handler: async (ctx, input) => {
        const p = templateDraft.parse(input)
        const to = await memberEmail(ctx.principal.id)
        if (!to) throw new EmailPlatformError('A test goes to your own address, and this caller has no email address: run it as a member.')
        const t = (await platform()).templates
        await t.updateTemplate(p.id, draftOf(p))
        const out = await t.sendTest(p.id, to)
        return { sentTo: to, status: out.status }
      },
    }),
    write({
      name: 'email.template_delete',
      summary: 'Delete a mail template.',
      destructive: true,
      activity: () => 'Deleted a mail template',
      inputSchema: byId,
      handler: async (_ctx, input) => {
        const { id } = byId.parse(input)
        await (await platform()).templates.deleteTemplate(id)
        return { id, removed: true }
      },
    }),

    // ── Flows ──────────────────────────────────────────────────────────────
    write({
      name: 'email.flow_create',
      summary: 'Create an email flow (a draft automation), optionally started by people joining a list.',
      activity: (input: z.infer<typeof flowCreate>) => `Created the email flow ${input.name}`,
      inputSchema: flowCreate,
      handler: async (ctx, input) => {
        const p = flowCreate.parse(input)
        const f = await (await platform()).audience.createFlow({ name: p.name, triggerListId: p.listId ?? null }, ctx.principal.id)
        return { id: f.id }
      },
    }),
    write({
      name: 'email.flow_update',
      summary: 'Save an email flow: name, the list that starts it, and its steps (the same step objects the flow editor saves; checked on save).',
      activity: (input: z.infer<typeof flowSave>) => `Saved the email flow ${input.name}`,
      inputSchema: flowSave,
      handler: async (_ctx, input) => {
        const p = flowSave.parse(input)
        await (await platform()).audience.updateFlow(p.id, { name: p.name, triggerListId: p.listId ?? null, steps: p.steps })
        return { id: p.id, saved: true }
      },
    }),
    write({
      name: 'email.flow_set_status',
      summary: 'Start (active) or pause an email flow.',
      activity: (input: z.infer<typeof flowStatus>) => (input.status === 'active' ? 'Started an email flow' : 'Paused an email flow'),
      inputSchema: flowStatus,
      handler: async (_ctx, input) => {
        const p = flowStatus.parse(input)
        return { status: (await (await platform()).audience.setFlowStatus(p.id, p.status)).status }
      },
    }),
    write({
      name: 'email.flow_delete',
      summary: 'Delete an email flow and the people in progress in it.',
      destructive: true,
      activity: () => 'Deleted an email flow',
      inputSchema: byId,
      handler: async (_ctx, input) => {
        const { id } = byId.parse(input)
        await (await platform()).audience.deleteFlow(id)
        return { id, removed: true }
      },
    }),

    // ── Contact lists ──────────────────────────────────────────────────────
    write({
      name: 'email.list_create',
      summary: 'Create a contact list (double opt-in: new people confirm by mail first).',
      activity: (input: z.infer<typeof listCreate>) => `Created the contact list ${input.name}`,
      inputSchema: listCreate,
      handler: async (ctx, input) => {
        const p = listCreate.parse(input)
        return { id: (await (await platform()).audience.createList({ name: p.name, doubleOptIn: p.doubleOptIn }, ctx.principal.id)).id }
      },
    }),
    write({
      name: 'email.list_update',
      summary: "A contact list's settings: name, description, double opt-in, public sign-up.",
      activity: (input: z.infer<typeof listSave>) => `Saved the settings of the contact list ${input.name}`,
      inputSchema: listSave,
      handler: async (_ctx, input) => {
        const p = listSave.parse(input)
        await (await platform()).audience.updateList(p.id, {
          name: p.name,
          description: p.description || null,
          doubleOptIn: p.doubleOptIn,
          publicSignup: p.publicSignup,
        })
        return { id: p.id, saved: true }
      },
    }),
    write({
      name: 'email.list_import',
      summary:
        'Import people into a list from CSV text (one per line: email, first name, last name; comma, semicolon or tab). They are subscribed directly. Returns added, updated and the invalid lines.',
      activity: () => 'Imported people into a contact list',
      inputSchema: listImport,
      handler: async (_ctx, input) => {
        const p = listImport.parse(input)
        return (await platform()).audience.importContacts(p.listId, p.csv)
      },
    }),
    {
      name: 'email.list_contacts',
      module: EMAIL_MODULE_ID,
      summary: 'The people on a contact list (id, email, name, status), optionally only one status.',
      auditClass: 'read',
      inputSchema: listContacts,
      permission: ROLES,
      handler: async (_ctx, input) => {
        const p = listContacts.parse(input)
        return (await (await platform()).audience.contacts(p.listId, p.status)).map((c) => ({
          id: c.id,
          email: c.email,
          firstName: c.firstName,
          lastName: c.lastName,
          status: c.status,
        }))
      },
    },
    write({
      name: 'email.contact_remove',
      summary: 'Remove a person from a contact list (the id from email.list_contacts).',
      destructive: true,
      activity: () => 'Removed a person from a contact list',
      inputSchema: byId,
      handler: async (_ctx, input) => {
        const { id } = byId.parse(input)
        await (await platform()).audience.removeContact(id)
        return { id, removed: true }
      },
    }),
    write({
      name: 'email.list_delete',
      summary: 'Delete a contact list and the people on it.',
      destructive: true,
      activity: () => 'Deleted a contact list',
      inputSchema: byId,
      handler: async (_ctx, input) => {
        const { id } = byId.parse(input)
        await (await platform()).audience.deleteList(id)
        return { id, removed: true }
      },
    }),

    // ── Senders ────────────────────────────────────────────────────────────
    write({
      name: 'email.sender_set_default',
      summary:
        "Make an address the default sender (sign-in codes go out from it). Own Amazon SES: one of the senders. eigenEnterprise Mail (managed): any address on one of the company's domains; ready says whether Amazon has verified it yet.",
      activity: (input: z.infer<typeof senderAddress>) => `Made ${input.address.trim().toLowerCase()} the default sender`,
      inputSchema: senderAddress,
      handler: async (ctx, input) => {
        const { address } = senderAddress.parse(input)
        const p = await platform()
        if ((await p.owlery.mode()) !== 'managed') {
          await p.setDefaultSender(await senderId(address), ctx.principal.id)
          return { address, ready: true }
        }
        // The managed box's rule (src/lib/server/onboarding/managed-sender.ts): a mail domain, or a bought one on its way.
        const domain = address.slice(address.lastIndexOf('@') + 1)
        const mail = (await p.listDomains()).find((d) => d.name === domain)
        if (!mail && !(await bought()).some((d) => d.name === domain && d.state !== 'failed')) {
          throw new EmailPlatformError(`${domain} is not one of the company’s domains yet. Buy or connect it first.`)
        }
        await p.owlery.setDefaultSender(address, ctx.principal.id)
        return { address, ready: mail?.sendable ?? false }
      },
    }),
    write({
      name: 'email.sender_remove',
      summary: 'Remove a sender address. Refused for the default sender: make another the default first.',
      destructive: true,
      activity: (input: z.infer<typeof senderAddress>) => `Removed the sender ${input.address.trim().toLowerCase()}`,
      inputSchema: senderAddress,
      handler: async (_ctx, input) => {
        const { address } = senderAddress.parse(input)
        await (await platform()).deleteSender(await senderId(address))
        return { address, removed: true }
      },
    }),

    // ── Setup at Amazon ────────────────────────────────────────────────────
    write({
      name: 'email.setup_events',
      summary: "Wire Amazon SES delivery events to this server (SNS topic, configuration sets, subscription). Safe to re-run; returns the events status.",
      activity: () => 'Set up delivery events at Amazon SES',
      inputSchema: none,
      handler: async () => ({ events: (await (await platform()).owlery.setupEvents(await origin())).eventsStatus }),
    }),
    write({
      name: 'email.setup_receiving',
      summary: 'Set up receiving mail at Amazon SES (bucket, topic, subscription, rule set and rules). Own SES only; safe to re-run.',
      activity: () => 'Set up receiving mail at Amazon SES',
      inputSchema: none,
      handler: async () => ({ receiving: (await (await platform()).setupReceiving(await origin())).receivingStatus }),
    }),
  ]
}
