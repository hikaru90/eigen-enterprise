import { z } from 'zod'
import type { ToolContext, ToolDescriptor } from '$lib/kernel/types'
import { CONTACTS_MODULE_ID } from './manifest'
import {
  createContact,
  deleteContact,
  followUps,
  importContacts,
  makeContactsPrivate,
  setCompanyDefaultVisibility,
  setMyDefaultVisibility,
  setShared,
  shareContacts,
  SHARING_MAX,
  getContact,
  listContacts,
  logContact,
  pipeline,
  updateContact,
  type Actor,
  type ContactInput,
  type ContactsDeps,
} from './service'
import {
  CHANNEL_TYPES,
  CONTACT_LIMITS,
  CONTACT_VISIBILITIES,
  IMPORT_MAX,
  DEFAULT_TAGS,
  FOLLOW_UP_WINDOW_DAYS,
  PIPELINE_STAGES,
  VIA_TYPES,
  WAITING_REVIEW_DAYS,
} from './types'

/**
 * contacts.* kernel tools: the agent's hands on the people tracker (in-app
 * assistant, `ee contacts.list`). Every call runs through the Contacts
 * service's access checks:
 * - a person calls as themselves — also when the company brain acts for them
 *   (CB3: the principal IS the person), or through an agent key that belongs
 *   to them: it sees what they see, and what it adds is their private contact;
 * - an agent principal that is no person acts with admin rights, like Drive's agent.
 * Every member reaches these tools (role 'member').
 * Writes are mutate-class and wait on the company's approval mode. Who sees
 * a contact, importing and the defaults stay a person's decision: the service
 * refuses the agent on its own (no person) there; a person — in the CLI, or
 * the brain acting for them — does what the page lets them do, no more.
 */

export type ContactsToolDeps = {
  deps?: () => Promise<ContactsDeps>
  /** For an agent principal: the member it IS (an API key of a person), or null (live: a member lookup). */
  agentPerson?: (ctx: ToolContext) => Promise<string | null>
  /** Today as `YYYY-MM-DD` (live: the UTC date). */
  today?: () => string
}

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'a date as YYYY-MM-DD')
const id = z.string().min(1).describe('the contact id')
const stage = z
  .enum(PIPELINE_STAGES)
  .describe(
    'the pipeline list (GTD): next = our move, a concrete next step we own; waiting = we wait on their reply; keep_in_touch = nothing open, check in on next_follow_up_on (the tickler); inbox = not contacted / not processed yet',
  )
const via = z.enum(VIA_TYPES).describe('how we are in touch with them')
const latestStatus = z.string().max(CONTACT_LIMITS.latestStatus).describe('where things stand, in a line')
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
  stage: stage.optional(),
  owner_id: z
    .string()
    .min(1)
    .nullable()
    .optional()
    .describe('who on our side holds the contact: a member’s user id (contacts.pipeline lists the people); null = nobody'),
  via: via.nullable().optional(),
  latest_status: latestStatus.nullable().optional(),
  waiting_since: day
    .nullable()
    .optional()
    .describe('only with stage waiting: since when we wait for their reply; defaults to today when the wait starts'),
}

const listInput = z
  .object({
    tag: z.string().max(CONTACT_LIMITS.tag).optional().describe('only contacts with this tag'),
    query: z.string().max(CONTACT_LIMITS.name).optional().describe('search in name and organisation'),
  })
  .strict()
const getInput = z.object({ id }).strict()
const followUpsInput = z.object({ today: day.optional().describe('defaults to today (UTC)') }).strict()
const pipelineInput = z
  .object({
    today: day.optional().describe('defaults to today (UTC)'),
    stage: stage.optional().describe('only this list'),
  })
  .strict()
const createInput = z.object({ name: z.string().min(1).max(CONTACT_LIMITS.name), ...fields }).strict()
const updateInput = z.object({ id, name: z.string().min(1).max(CONTACT_LIMITS.name).optional(), ...fields }).strict()
const logInput = z
  .object({
    id,
    on: day.optional().describe('the day you were in touch; defaults to today (UTC)'),
    how_it_went: z.string().max(CONTACT_LIMITS.logNote).nullable().optional().describe('what happened and how it went; kept in the contact’s history'),
    next_follow_up_on: day.nullable().optional().describe('the next follow-up; none when left out'),
    next_step: z.string().max(CONTACT_LIMITS.nextStep).nullable().optional(),
    stage: stage.optional().describe('where they are now; left out, the list stays as it is. waiting starts the wait on the day you were in touch'),
    via: via.nullable().optional(),
    latest_status: latestStatus.nullable().optional(),
  })
  .strict()

const ids = z.array(z.string().min(1)).min(1).max(SHARING_MAX).describe('the contact ids')
const visibility = z
  .enum([...CONTACT_VISIBILITIES, 'company'])
  .describe('private, team (the whole team), or company = follow the company default')
const setSharedInput = z
  .object({ id, shared: z.boolean().describe('true = the whole team sees it; false = private again (also ends its shares with people and groups)') })
  .strict()
const shareManyInput = z
  .object({
    action: z.enum(['share', 'private']).describe('share = add whom to share with (existing shares stay); private = no shares left'),
    ids,
    targets: z
      .object({
        team: z.boolean().optional().describe('the whole team'),
        user_ids: z.array(z.string().min(1)).optional().describe('members’ user ids (contacts.pipeline lists the people)'),
        group_ids: z.array(z.string().min(1)).optional().describe('Members › Groups ids'),
      })
      .strict()
      .optional()
      .describe('with action share: whom to share with (at least one)'),
  })
  .strict()
const candidate = z
  .object({
    name: z.string().min(1).max(CONTACT_LIMITS.name),
    organisation: fields.organisation,
    title: fields.title,
    channels: fields.channels,
    met_how: fields.met_how,
    why_relevant: fields.why_relevant,
    tags: fields.tags,
  })
  .strict()
const importInput = z
  .object({
    contacts: z.array(candidate).min(1).max(IMPORT_MAX).describe('the people to add; one already known by email is skipped, never changed'),
    shared: z.boolean().optional().describe('true = the whole team sees them, false = private; left out: your default for new contacts'),
  })
  .strict()
const defaultInput = z.object({ visibility }).strict()

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
    stage: i.stage,
    ownerId: i.owner_id,
    via: i.via,
    latestStatus: i.latest_status,
    waitingSince: i.waiting_since,
  }
}

async function liveDeps(): Promise<ContactsDeps> {
  const { contactsDeps } = await import('./live')
  return contactsDeps()
}

/** An agent principal that IS a person (their API key): that member's id, else null. */
async function liveAgentPerson(ctx: ToolContext): Promise<string | null> {
  const { getUserRole } = await import('$lib/server/auth/user-role')
  return (await getUserRole(ctx.principal.id)) ? ctx.principal.id : null
}

const utcToday = () => new Date().toISOString().slice(0, 10)

export function createContactsTools(opts: ContactsToolDeps = {}): ToolDescriptor[] {
  const deps = opts.deps ?? liveDeps
  const agentPerson = opts.agentPerson ?? liveAgentPerson
  const today = opts.today ?? utcToday

  async function actorOf(ctx: ToolContext): Promise<Actor> {
    // A person — themselves, or the brain acting as them (CB3: the principal IS the person).
    if (ctx.principal.kind === 'human') return { kind: 'user', userId: ctx.principal.id }
    const person = await agentPerson(ctx)
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
      permission: { roles: ['admin', 'member', 'agent'] },
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
      permission: { roles: ['admin', 'member', 'agent'] },
      handler: async (ctx, input) => getContact(await deps(), await actorOf(ctx), getInput.parse(input).id),
    },
    {
      name: 'contacts.follow_ups',
      module: CONTACTS_MODULE_ID,
      summary: `Who to write to next: contacts whose follow-up is due (overdue or today) or comes up within ${FOLLOW_UP_WINDOW_DAYS} days, soonest first, each with its next step.`,
      auditClass: 'read',
      inputSchema: followUpsInput,
      permission: { roles: ['admin', 'member', 'agent'] },
      handler: async (ctx, input) => {
        const day = followUpsInput.parse(input).today ?? today()
        return { today: day, windowDays: FOLLOW_UP_WINDOW_DAYS, followUps: await followUps(await deps(), await actorOf(ctx), day) }
      },
    },
    {
      name: 'contacts.pipeline',
      module: CONTACTS_MODULE_ID,
      summary: `The contact pipeline, Getting Things Done style: every contact you may see in its list — next (our move: a next step we own), waiting (on their reply, since when), keep_in_touch (tickler: check in on next_follow_up_on), inbox (not contacted yet) — each with who on our side holds it, how we are in touch, latest status, next step and its day. The weekly review flags what to look at: days that have passed, replies waited on longer than ${WAITING_REVIEW_DAYS} days, our moves with no next step, and the inbox. Also lists the people who can hold a contact (their ids for owner_id). Move a contact with contacts.update (stage) or contacts.log_contact.`,
      auditClass: 'read',
      inputSchema: pipelineInput,
      permission: { roles: ['admin', 'member', 'agent'] },
      handler: async (ctx, input) => {
        const i = pipelineInput.parse(input)
        const out = await pipeline(await deps(), await actorOf(ctx), i.today ?? today())
        return i.stage ? { ...out, groups: out.groups.filter((g) => g.stage === i.stage) } : out
      },
    },
    {
      name: 'contacts.create',
      module: CONTACTS_MODULE_ID,
      summary:
        'Add a person to Contacts. It starts as the default for new contacts — the person you work for’s own setting, else the company’s (private or the whole team); working on your own, the company’s. Only people change who sees a contact afterwards.',
      auditClass: 'mutate',
      approvalRisk: 'internal',
      activity: () => 'Added a contact',
      inputSchema: createInput,
      permission: { roles: ['admin', 'member', 'agent'] },
      handler: async (ctx, input) =>
        createContact(await deps(), await actorOf(ctx), contactInput(createInput.parse(input)), { today: today() }),
    },
    {
      name: 'contacts.update',
      module: CONTACTS_MODULE_ID,
      summary:
        'Change a contact: only the fields you send change; null (or empty text) clears an optional field; channels and tags replace the whole list. Moves it between pipeline lists (stage), sets who holds it (owner_id), how we are in touch (via) and the latest status.',
      auditClass: 'mutate',
      approvalRisk: 'internal',
      activity: () => 'Updated a contact',
      inputSchema: updateInput,
      permission: { roles: ['admin', 'member', 'agent'] },
      handler: async (ctx, input) => {
        const { id: contactId, ...rest } = updateInput.parse(input)
        return updateContact(await deps(), await actorOf(ctx), contactId, contactInput(rest), { today: today() })
      },
    },
    {
      name: 'contacts.delete',
      module: CONTACTS_MODULE_ID,
      summary: 'Delete a contact for good: the person who added it, the owner and admins.',
      auditClass: 'mutate',
      approvalRisk: 'destructive',
      activity: () => 'Deleted a contact',
      inputSchema: getInput,
      permission: { roles: ['admin', 'member', 'agent'] },
      handler: async (ctx, input) => {
        const contactId = getInput.parse(input).id
        await deleteContact(await deps(), await actorOf(ctx), contactId)
        return { deleted: contactId }
      },
    },
    {
      name: 'contacts.set_shared',
      module: CONTACTS_MODULE_ID,
      summary:
        'Change who sees one contact: shared = true for the whole team, false to make it private again. Its creator, the owner and admins; a person’s act — the agent on its own is refused.',
      auditClass: 'mutate',
      approvalRisk: 'internal',
      activity: (input) => ((input as { shared?: boolean }).shared ? 'Shared a contact with the team' : 'Made a contact private'),
      inputSchema: setSharedInput,
      permission: { roles: ['admin', 'member', 'agent'] },
      handler: async (ctx, input) => {
        const i = setSharedInput.parse(input)
        return setShared(await deps(), await actorOf(ctx), i.id, i.shared)
      },
    },
    {
      name: 'contacts.share_many',
      module: CONTACTS_MODULE_ID,
      summary: `Share many contacts at once (the whole team and/or people and groups) or make them private, up to ${SHARING_MAX}. Contacts that are not yours (or that you do not see) are skipped and reported. A person’s act — the agent on its own is refused.`,
      auditClass: 'mutate',
      approvalRisk: 'internal',
      activity: (input) => ((input as { action?: string }).action === 'private' ? 'Made contacts private' : 'Shared contacts'),
      inputSchema: shareManyInput,
      permission: { roles: ['admin', 'member', 'agent'] },
      handler: async (ctx, input) => {
        const i = shareManyInput.parse(input)
        const actor = await actorOf(ctx)
        if (i.action === 'private') return makeContactsPrivate(await deps(), actor, i.ids)
        const t = i.targets
        return shareContacts(await deps(), actor, i.ids, t && { team: t.team, userIds: t.user_ids, groupIds: t.group_ids })
      },
    },
    {
      name: 'contacts.import',
      module: CONTACTS_MODULE_ID,
      summary: `Import contacts (as from a vCard or CSV file, read into rows): up to ${IMPORT_MAX} at once. A row that is not importable stops the import (nothing added); one already known by email is skipped. A person’s act — the agent on its own is refused.`,
      auditClass: 'mutate',
      approvalRisk: 'internal',
      activity: () => 'Imported contacts',
      inputSchema: importInput,
      permission: { roles: ['admin', 'member', 'agent'] },
      handler: async (ctx, input) => {
        const i = importInput.parse(input)
        const rows = i.contacts.map((c) => ({
          name: c.name,
          ...(c.organisation !== undefined && { organisation: c.organisation }),
          ...(c.title !== undefined && { title: c.title }),
          ...(c.channels !== undefined && { channels: c.channels }),
          ...(c.met_how !== undefined && { metHow: c.met_how }),
          ...(c.why_relevant !== undefined && { whyRelevant: c.why_relevant }),
          ...(c.tags !== undefined && { tags: c.tags }),
        }))
        const out = await importContacts(await deps(), await actorOf(ctx), rows, i.shared === undefined ? {} : { shared: i.shared })
        return { imported: out.created.map((c) => ({ id: c.id, name: c.name })), skipped: out.skipped.length }
      },
    },
    {
      name: 'contacts.set_my_default_visibility',
      module: CONTACTS_MODULE_ID,
      summary: 'Your own default for who sees a contact you add: private, team, or company (follow the company default). A person’s setting.',
      auditClass: 'mutate',
      approvalRisk: 'internal',
      activity: () => 'Set my default visibility for new contacts',
      inputSchema: defaultInput,
      permission: { roles: ['admin', 'member', 'agent'] },
      handler: async (ctx, input) => setMyDefaultVisibility(await deps(), await actorOf(ctx), defaultInput.parse(input).visibility),
    },
    {
      name: 'contacts.set_company_default_visibility',
      module: CONTACTS_MODULE_ID,
      summary: 'The company-wide default for who sees new contacts: private or team (company = unset, i.e. private). The owner and admins only.',
      auditClass: 'mutate',
      approvalRisk: 'internal',
      activity: () => 'Set the company default visibility for new contacts',
      inputSchema: defaultInput,
      permission: { roles: ['admin', 'member', 'agent'] },
      handler: async (ctx, input) => setCompanyDefaultVisibility(await deps(), await actorOf(ctx), defaultInput.parse(input).visibility),
    },
    {
      name: 'contacts.log_contact',
      module: CONTACTS_MODULE_ID,
      summary:
        'Record that you were in touch with a contact (sets last contacted; kept in the contact’s history with how it went) and set the next follow-up and next step — the previous follow-up is done, so leaving them out clears them. Say where they are now with stage (e.g. waiting after you wrote and expect a reply); left out, the pipeline list stays as it is.',
      auditClass: 'mutate',
      approvalRisk: 'internal',
      activity: () => 'Logged being in touch with a contact',
      inputSchema: logInput,
      permission: { roles: ['admin', 'member', 'agent'] },
      handler: async (ctx, input) => {
        const i = logInput.parse(input)
        return logContact(await deps(), await actorOf(ctx), i.id, {
          on: i.on ?? today(),
          note: i.how_it_went,
          nextFollowUpOn: i.next_follow_up_on,
          nextStep: i.next_step,
          stage: i.stage,
          via: i.via,
          latestStatus: i.latest_status,
        })
      },
    },
  ]
}
