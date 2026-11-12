import { z } from 'zod'
import type { ToolContext, ToolDescriptor } from '$lib/kernel/types'
import { CONTACTS_MODULE_ID } from './manifest'
import {
  createContact,
  followUps,
  getContact,
  listContacts,
  logContact,
  updateContact,
  type Actor,
  type ContactInput,
  type ContactsDeps,
} from './service'
import { CHANNEL_TYPES, CONTACT_LIMITS, DEFAULT_TAGS, FOLLOW_UP_WINDOW_DAYS } from './types'

/**
 * contacts.* kernel tools: the agent's hands on the people tracker (in-app
 * assistant, `ee contacts.list`). Every call runs through the Contacts
 * service's access checks:
 * - a person calls as themselves;
 * - the agent working for a person (the signed-in person it is answering, or
 *   an agent key that belongs to a person) is that person: it sees what they
 *   see, and what it adds is their private contact;
 * - the agent on its own acts with admin rights, like Drive's agent.
 * Writes are mutate-class and wait on the company's approval mode. Sharing
 * and deleting are not tools: who can see a contact is a person's decision.
 */

export type ContactsToolDeps = {
  deps?: () => Promise<ContactsDeps>
  /** The person the agent works for, if any (live: the request's signed-in user, or a principal that is a person). */
  onBehalfOf?: (ctx: ToolContext) => Promise<string | null>
  /** Today as `YYYY-MM-DD` (live: the UTC date). */
  today?: () => string
}

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'a date as YYYY-MM-DD')
const id = z.string().min(1).describe('the contact id')
const channel = z.object({ type: z.enum(CHANNEL_TYPES), value: z.string().min(1).max(CONTACT_LIMITS.channelValue) }).strict()

const fields = {
  organisation: z.string().max(CONTACT_LIMITS.organisation).nullable().optional(),
  title: z.string().max(CONTACT_LIMITS.title).nullable().optional().describe('role or job title'),
  channels: z
    .array(channel)
    .max(CONTACT_LIMITS.channels)
    .optional()
    .describe('how to reach them; replaces the whole list'),
  met_how: z.string().max(CONTACT_LIMITS.metHow).nullable().optional().describe('where or how you met'),
  why_relevant: z.string().max(CONTACT_LIMITS.whyRelevant).nullable().optional().describe('why this person matters'),
  tags: z
    .array(z.string().min(1).max(CONTACT_LIMITS.tag))
    .max(CONTACT_LIMITS.tags)
    .optional()
    .describe(`replaces the list; the usual ones are ${DEFAULT_TAGS.join(', ')}, or any word of your own`),
  last_contacted_on: day.nullable().optional(),
  next_follow_up_on: day.nullable().optional(),
  next_step: z.string().max(CONTACT_LIMITS.nextStep).nullable().optional().describe('what to do at the next follow-up'),
}

const listInput = z
  .object({
    tag: z.string().max(CONTACT_LIMITS.tag).optional().describe('only contacts with this tag'),
    query: z.string().max(CONTACT_LIMITS.name).optional().describe('search in name and organisation'),
  })
  .strict()
const getInput = z.object({ id }).strict()
const followUpsInput = z.object({ today: day.optional().describe('defaults to today (UTC)') }).strict()
const createInput = z.object({ name: z.string().min(1).max(CONTACT_LIMITS.name), ...fields }).strict()
const updateInput = z.object({ id, name: z.string().min(1).max(CONTACT_LIMITS.name).optional(), ...fields }).strict()
const logInput = z
  .object({
    id,
    on: day.optional().describe('the day you were in touch; defaults to today (UTC)'),
    next_follow_up_on: day.nullable().optional().describe('the next follow-up; none when left out'),
    next_step: z.string().max(CONTACT_LIMITS.nextStep).nullable().optional(),
  })
  .strict()

type Fields = Partial<{ [K in keyof typeof fields]: z.infer<(typeof fields)[K]> }> & { name?: string }

function contactInput(i: Fields): ContactInput {
  return {
    name: i.name,
    organisation: i.organisation,
    title: i.title,
    channels: i.channels,
    metHow: i.met_how,
    whyRelevant: i.why_relevant,
    tags: i.tags,
    lastContactedOn: i.last_contacted_on,
    nextFollowUpOn: i.next_follow_up_on,
    nextStep: i.next_step,
  }
}

async function liveDeps(): Promise<ContactsDeps> {
  const { contactsDeps } = await import('./live')
  return contactsDeps()
}

async function liveOnBehalfOf(ctx: ToolContext): Promise<string | null> {
  const { tenantUserAsyncLocal } = await import('$lib/server/db/tenant-context')
  const signedIn = tenantUserAsyncLocal.getStore()
  if (signedIn) return signedIn
  const { getUserRole } = await import('$lib/server/auth/user-role')
  return (await getUserRole(ctx.principal.id)) ? ctx.principal.id : null
}

const utcToday = () => new Date().toISOString().slice(0, 10)

export function createContactsTools(opts: ContactsToolDeps = {}): ToolDescriptor[] {
  const deps = opts.deps ?? liveDeps
  const onBehalfOf = opts.onBehalfOf ?? liveOnBehalfOf
  const today = opts.today ?? utcToday

  async function actorOf(ctx: ToolContext): Promise<Actor> {
    if (ctx.principal.kind === 'human') return { kind: 'user', userId: ctx.principal.id }
    const person = await onBehalfOf(ctx)
    return person ? { kind: 'user', userId: person } : { kind: 'agent', id: ctx.principal.id }
  }

  return [
    {
      name: 'contacts.list',
      module: CONTACTS_MODULE_ID,
      summary:
        'List the people in Contacts you may see (by name): organisation, role, channels (email, phone, LinkedIn, website), where you met, why they matter, tags, last contacted, next follow-up. Filter by one tag and/or search name and organisation. Also returns the tags in use.',
      auditClass: 'read',
      inputSchema: listInput,
      permission: { roles: ['admin', 'agent'] },
      handler: async (ctx, input) => {
        const i = listInput.parse(input)
        return listContacts(await deps(), await actorOf(ctx), { tag: i.tag, query: i.query })
      },
    },
    {
      name: 'contacts.get',
      module: CONTACTS_MODULE_ID,
      summary: 'Read one contact by id.',
      auditClass: 'read',
      inputSchema: getInput,
      permission: { roles: ['admin', 'agent'] },
      handler: async (ctx, input) => getContact(await deps(), await actorOf(ctx), getInput.parse(input).id),
    },
    {
      name: 'contacts.follow_ups',
      module: CONTACTS_MODULE_ID,
      summary: `Who to write to next: contacts whose follow-up is due (overdue or today) or comes up within ${FOLLOW_UP_WINDOW_DAYS} days, soonest first, each with its next step.`,
      auditClass: 'read',
      inputSchema: followUpsInput,
      permission: { roles: ['admin', 'agent'] },
      handler: async (ctx, input) => {
        const day = followUpsInput.parse(input).today ?? today()
        return { today: day, windowDays: FOLLOW_UP_WINDOW_DAYS, followUps: await followUps(await deps(), await actorOf(ctx), day) }
      },
    },
    {
      name: 'contacts.create',
      module: CONTACTS_MODULE_ID,
      summary:
        'Add a person to Contacts. It is private to the person you work for (plus the company owner and admins) until they share it themselves.',
      auditClass: 'mutate',
      approvalRisk: 'internal',
      activity: () => 'Added a contact',
      inputSchema: createInput,
      permission: { roles: ['admin', 'agent'] },
      handler: async (ctx, input) => createContact(await deps(), await actorOf(ctx), contactInput(createInput.parse(input))),
    },
    {
      name: 'contacts.update',
      module: CONTACTS_MODULE_ID,
      summary: 'Change a contact: only the fields you send change; null (or empty text) clears an optional field; channels and tags replace the whole list.',
      auditClass: 'mutate',
      approvalRisk: 'internal',
      activity: () => 'Updated a contact',
      inputSchema: updateInput,
      permission: { roles: ['admin', 'agent'] },
      handler: async (ctx, input) => {
        const { id: contactId, ...rest } = updateInput.parse(input)
        return updateContact(await deps(), await actorOf(ctx), contactId, contactInput(rest))
      },
    },
    {
      name: 'contacts.log_contact',
      module: CONTACTS_MODULE_ID,
      summary:
        'Record that you were in touch with a contact (sets last contacted) and set the next follow-up and next step — the previous follow-up is done, so leaving them out clears them.',
      auditClass: 'mutate',
      approvalRisk: 'internal',
      activity: () => 'Logged being in touch with a contact',
      inputSchema: logInput,
      permission: { roles: ['admin', 'agent'] },
      handler: async (ctx, input) => {
        const i = logInput.parse(input)
        return logContact(await deps(), await actorOf(ctx), i.id, {
          on: i.on ?? today(),
          nextFollowUpOn: i.next_follow_up_on,
          nextStep: i.next_step,
        })
      },
    },
  ]
}
