import type { EmailPlatform } from './service'
import { z } from 'zod'
import type { ToolDescriptor } from '$lib/kernel/types'
import { EMAIL_MODULE_ID } from '../manifest'
import { MESSAGE_STATUSES } from './status'

/**
 * The assistant's hands on the email platform (plan/phase-polish-1.md P-6).
 * Reads are free; every change waits on the approval gate (APPROVAL_REQUIRED_TOOLS).
 * No tool returns or records a message body: the log tools give metadata and
 * the status timeline only, activity sentences name addresses, never content.
 */

export type EmailPlatformToolDeps = { platform?: () => EmailPlatform }

const ROLES = { roles: ['admin', 'agent'] }

export function createEmailPlatformTools(deps: EmailPlatformToolDeps = {}): ToolDescriptor[] {
  const platform = async (): Promise<EmailPlatform> => {
    if (deps.platform) return deps.platform()
    const { emailPlatform } = await import('./service')
    return emailPlatform()
  }

  const domainAdd = z.object({ domain: z.string().min(1) }).strict()
  const byId = z.object({ id: z.uuid() }).strict()
  const senderAdd = z.object({ address: z.email(), displayName: z.string().max(120).optional() }).strict()
  const emailOnly = z.object({ email: z.email() }).strict()
  const templateSend = z
    .object({
      templateId: z.uuid(),
      to: z.email(),
      variables: z.record(z.string(), z.string()).default({}),
      from: z.email().optional(),
    })
    .strict()
  const contactAdd = z
    .object({
      listId: z.uuid(),
      email: z.email(),
      firstName: z.string().max(200).optional(),
      lastName: z.string().max(200).optional(),
    })
    .strict()
  const logList = z
    .object({
      status: z.enum(MESSAGE_STATUSES).optional(),
      search: z.string().max(200).optional(),
      limit: z.number().int().min(1).max(100).default(20),
    })
    .strict()

  return [
    {
      name: 'email.domain_list',
      module: EMAIL_MODULE_ID,
      summary: 'The sender domains with their verification status and the DNS records the owner must publish (type, host, value, status).',
      auditClass: 'read',
      inputSchema: z.object({}).strict(),
      permission: ROLES,
      handler: async () =>
        (await (await platform()).listDomains()).map((d) => ({
          id: d.id,
          name: d.name,
          status: d.status,
          sendable: d.sendable,
          tracking: d.tracking,
          error: d.errorMessage,
          records: d.records,
        })),
    },
    {
      name: 'email.domain_add',
      module: EMAIL_MODULE_ID,
      summary: 'Add a sender domain at Amazon SES with its own DKIM key. Returns the DNS records the owner must add at their DNS provider.',
      auditClass: 'mutate',
      approvalRisk: 'internal',
      activity: (input: z.infer<typeof domainAdd>) => `Added the sender domain ${input.domain}`,
      inputSchema: domainAdd,
      permission: ROLES,
      handler: async (ctx, input) => {
        const d = await (await platform()).addDomain(domainAdd.parse(input).domain, ctx.principal.id)
        return { id: d.id, name: d.name, status: d.status, records: d.records }
      },
    },
    {
      name: 'email.domain_recheck',
      module: EMAIL_MODULE_ID,
      summary: "Ask Amazon again whether a domain's DNS records are in place; returns the new status per record.",
      auditClass: 'mutate',
      approvalRisk: 'internal',
      activity: () => 'Re-checked a sender domain',
      inputSchema: byId,
      permission: ROLES,
      handler: async (_ctx, input) => {
        const d = await (await platform()).recheckDomain(byId.parse(input).id)
        return { id: d.id, name: d.name, status: d.status, sendable: d.sendable, error: d.errorMessage, records: d.records }
      },
    },
    {
      name: 'email.sender_list',
      module: EMAIL_MODULE_ID,
      summary: 'The addresses the company can send from, with display names; marks the default sender.',
      auditClass: 'read',
      inputSchema: z.object({}).strict(),
      permission: ROLES,
      handler: async () =>
        (await (await platform()).listSenders()).map((s) => ({
          address: s.address,
          displayName: s.displayName,
          domain: s.domainName,
          isDefault: s.isDefault,
        })),
    },
    {
      name: 'email.sender_add',
      module: EMAIL_MODULE_ID,
      summary: 'Add a named sender address on a verified domain.',
      auditClass: 'mutate',
      approvalRisk: 'internal',
      activity: (input: z.infer<typeof senderAdd>) => `Added the sender ${input.address}`,
      inputSchema: senderAdd,
      permission: ROLES,
      handler: async (ctx, input) => {
        const p = senderAdd.parse(input)
        const s = await (await platform()).addSender({ address: p.address, displayName: p.displayName ?? null }, ctx.principal.id)
        return { address: s.address, displayName: s.displayName }
      },
    },
    {
      name: 'email.log_list',
      module: EMAIL_MODULE_ID,
      summary: 'Recent sent mail (recipient, subject, sender, source, status, time), newest first. Never the body.',
      auditClass: 'read',
      inputSchema: logList,
      permission: ROLES,
      handler: async (_ctx, input) => {
        const p = logList.parse(input)
        const rows = await (await platform()).store.listMessages({ status: p.status, search: p.search, limit: p.limit })
        return rows.map((m) => ({
          id: m.id,
          to: m.toAddress,
          from: m.fromAddress,
          subject: m.subject,
          source: m.source,
          status: m.status,
          createdAt: m.createdAt.toISOString(),
        }))
      },
    },
    {
      name: 'email.log_get',
      module: EMAIL_MODULE_ID,
      summary: 'One sent mail with its status timeline (queued, sent, delivered, bounced with the reason, opened …). Never the body.',
      auditClass: 'read',
      inputSchema: byId,
      permission: ROLES,
      handler: async (_ctx, input) => {
        const store = (await platform()).store
        const m = await store.getMessage(byId.parse(input).id)
        if (!m) return { found: false }
        const events = await store.events(m.id)
        return {
          found: true,
          id: m.id,
          to: m.toAddress,
          from: m.fromAddress,
          subject: m.subject,
          source: m.source,
          status: m.status,
          error: m.error,
          timeline: events.map((e) => ({ status: e.status, at: e.occurredAt.toISOString(), detail: e.detail })),
        }
      },
    },
    {
      name: 'email.suppression_list',
      module: EMAIL_MODULE_ID,
      summary: 'Addresses the company never mails (hard bounces, spam complaints, manual), with the reason.',
      auditClass: 'read',
      inputSchema: z.object({ search: z.string().max(200).optional() }).strict(),
      permission: ROLES,
      handler: async (_ctx, input) => {
        const { search } = z.object({ search: z.string().optional() }).parse(input)
        return (await (await platform()).store.listSuppressions(search)).map((s) => ({
          email: s.email,
          reason: s.reason,
          since: s.createdAt.toISOString(),
        }))
      },
    },
    {
      name: 'email.template_list',
      module: EMAIL_MODULE_ID,
      summary: 'The saved email templates (id, name, subject, the variables each expects). Send one with email.send_template.',
      auditClass: 'read',
      inputSchema: z.object({}).strict(),
      permission: ROLES,
      handler: async () => {
        const t = (await platform()).templates
        const rows = await t.listTemplates()
        return Promise.all(
          rows.map(async (r) => ({ id: r.id, name: r.name, subject: r.subject, format: r.format, variables: await t.variablesOf(r) })),
        )
      },
    },
    {
      name: 'email.template_get',
      module: EMAIL_MODULE_ID,
      summary: "One template's source (subject, MJML/HTML body, layout) and the variables it expects.",
      auditClass: 'read',
      inputSchema: byId,
      permission: ROLES,
      handler: async (_ctx, input) => {
        const t = (await platform()).templates
        const r = await t.getTemplate(byId.parse(input).id)
        return {
          id: r.id,
          name: r.name,
          subject: r.subject,
          format: r.format,
          body: r.body,
          layoutId: r.layoutId,
          variables: await t.variablesOf(r),
        }
      },
    },
    {
      name: 'email.send_template',
      module: EMAIL_MODULE_ID,
      summary:
        'Send a saved template to one recipient with its variables (from: one of the senders, default otherwise). Fails with the list of missing variables.',
      auditClass: 'external',
      approvalRisk: 'external',
      // Recipient and template only: the rendered content stays out of the audit trail.
      activity: (input: z.infer<typeof templateSend>) => `Sent a template email to ${input.to}`,
      inputSchema: templateSend,
      permission: ROLES,
      handler: async (_ctx, input) => {
        const p = templateSend.parse(input)
        return (await platform()).templates.send({
          templateId: p.templateId,
          to: p.to,
          variables: p.variables,
          source: 'agent',
          ...(p.from ? { from: p.from } : {}),
        })
      },
    },
    {
      name: 'email.contact_lists',
      module: EMAIL_MODULE_ID,
      summary: 'The contact lists (id, name, double opt-in, how many are subscribed / waiting to confirm / unsubscribed).',
      auditClass: 'read',
      inputSchema: z.object({}).strict(),
      permission: ROLES,
      handler: async () =>
        (await (await platform()).audience.listLists()).map((l) => ({
          id: l.id,
          name: l.name,
          doubleOptIn: l.doubleOptIn,
          subscribed: l.subscribed,
          pending: l.pending,
          unsubscribed: l.unsubscribed,
        })),
    },
    {
      name: 'email.contact_add',
      module: EMAIL_MODULE_ID,
      summary:
        'Add a person to a contact list. On a double-opt-in list they get a confirmation mail first; otherwise they are subscribed and the list’s running flows start for them.',
      auditClass: 'mutate',
      approvalRisk: 'internal',
      activity: (input: z.infer<typeof contactAdd>) => `Added ${input.email} to a contact list`,
      inputSchema: contactAdd,
      permission: ROLES,
      handler: async (_ctx, input) => {
        const p = contactAdd.parse(input)
        const out = await (await platform()).audience.addContact(p.listId, {
          email: p.email,
          firstName: p.firstName ?? null,
          lastName: p.lastName ?? null,
        })
        return { email: out.contact.email, status: out.contact.status, created: out.created }
      },
    },
    {
      name: 'email.flow_list',
      module: EMAIL_MODULE_ID,
      summary: 'The email flows (automations): status, the list that starts them, step count, people in progress and done.',
      auditClass: 'read',
      inputSchema: z.object({}).strict(),
      permission: ROLES,
      handler: async () =>
        (await (await platform()).audience.listFlows()).map((f) => ({
          id: f.id,
          name: f.name,
          status: f.status,
          triggerListId: f.triggerListId,
          steps: Array.isArray(f.steps) ? f.steps.length : 0,
          inProgress: f.active,
          completed: f.completed,
        })),
    },
    {
      name: 'email.suppression_add',
      module: EMAIL_MODULE_ID,
      summary: 'Stop all mail to an address (adds it to the suppression list).',
      auditClass: 'mutate',
      approvalRisk: 'internal',
      activity: (input: z.infer<typeof emailOnly>) => `Suppressed ${input.email}`,
      inputSchema: emailOnly,
      permission: ROLES,
      handler: async (ctx, input) => {
        const s = await (await platform()).suppress(emailOnly.parse(input).email, ctx.principal.id)
        return { email: s.email, reason: s.reason }
      },
    },
    {
      name: 'email.suppression_remove',
      module: EMAIL_MODULE_ID,
      summary: "Allow mail to an address again (removes it from the suppression list and from Amazon's account-level list).",
      auditClass: 'mutate',
      approvalRisk: 'internal',
      activity: (input: z.infer<typeof emailOnly>) => `Removed ${input.email} from the suppression list`,
      inputSchema: emailOnly,
      permission: ROLES,
      handler: async (_ctx, input) => {
        const { email } = emailOnly.parse(input)
        await (await platform()).unsuppress(email)
        return { email, removed: true }
      },
    },
  ]
}
