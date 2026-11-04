import type { OwleryService } from '../../owlery/service'
import type { JobRow } from '../store'
import { randomBytes, randomUUID } from 'node:crypto'
import { and, asc, count, desc, eq, inArray } from 'drizzle-orm'
import type { DbHandle } from '$lib/kernel/db-stores'
import type { AppDatabase } from '$lib/server/db/context'
import {
  mailContactLists,
  mailContacts,
  mailFlowEnrollments,
  mailFlowLog,
  mailFlows,
  type ContactStatus,
  type FlowLogEvent,
  type FlowStatus,
  type UnsubscribeReason,
} from '$lib/server/db/email-contacts.schema'
import { normalizeEmail } from '../suppression'
import { TemplateRenderError, type TemplateService } from '../templates/service'
import { escapeHtml } from '../templates/variables'
import { flowSteps, nextAction, type FlowStep } from './engine'

/**
 * Contacts and flows (plan/phase-polish-1.md P-6, E-P3; Owlery's contact
 * books, double opt-in and flow engine). Lists hold contacts; a contact on a
 * double-opt-in list is "pending" until it clicks the emailed link. A flow
 * starts for every contact that becomes subscribed on its trigger list and
 * runs its steps on the email module's background jobs (job kind flow_step).
 */

export const FLOW_STEP_JOB = 'flow_step'

export type ContactListRow = typeof mailContactLists.$inferSelect
export type ContactRow = typeof mailContacts.$inferSelect
export type FlowRow = typeof mailFlows.$inferSelect
export type EnrollmentRow = typeof mailFlowEnrollments.$inferSelect
export type FlowLogRow = typeof mailFlowLog.$inferSelect

export class AudienceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AudienceError'
  }
}

export type AudienceDeps = {
  db: DbHandle
  owlery: OwleryService
  templates: TemplateService
  /** Enqueue a background job (EmailStore.enqueueJob). */
  enqueue: (kind: string, payload: Record<string, unknown>, runAt: Date, dedupeKey?: string) => Promise<void>
  /** This server's public origin, for unsubscribe and confirm links (ORIGIN). */
  origin: () => string
  now?: () => Date
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ADDRESS = /^[^\s@<>"]+@[^\s@<>"]+$/

/**
 * One pending job per wait (a job may enqueue the next one while it still
 * runs, so the key names the step and its time; runEnrollment is safe to run
 * twice — it acts on the enrollment's stored state).
 */
const waitKey = (enrollmentId: string, stepIndex: number, until: Date) => `flow:${enrollmentId}:${stepIndex}:${until.toISOString()}`

export type NewContact = { email: string; firstName?: string | null; lastName?: string | null; properties?: Record<string, string> }

export class AudienceService {
  constructor(private readonly deps: AudienceDeps) {}

  private async db(): Promise<AppDatabase> {
    return typeof this.deps.db === 'function' ? await this.deps.db() : this.deps.db
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date()
  }

  // ─── links ─────────────────────────────────────────────────────────────────

  unsubscribeUrl(token: string): string {
    return `${this.deps.origin()}/mail/unsubscribe/${token}`
  }

  oneClickUrl(token: string): string {
    return `${this.deps.origin()}/api/mail/unsubscribe/${token}`
  }

  confirmUrl(token: string): string {
    return `${this.deps.origin()}/mail/confirm/${token}`
  }

  /** RFC 8058 one-click unsubscribe headers for mail to a contact. */
  unsubscribeHeaders(token: string): { name: string; value: string }[] {
    return [
      { name: 'List-Unsubscribe', value: `<${this.oneClickUrl(token)}>` },
      { name: 'List-Unsubscribe-Post', value: 'List-Unsubscribe=One-Click' },
    ]
  }

  // ─── lists ─────────────────────────────────────────────────────────────────

  async listLists(): Promise<(ContactListRow & { subscribed: number; pending: number; unsubscribed: number })[]> {
    const db = await this.db()
    const lists = await db.select().from(mailContactLists).orderBy(asc(mailContactLists.createdAt))
    const counts = await db
      .select({ listId: mailContacts.listId, status: mailContacts.status, n: count() })
      .from(mailContacts)
      .groupBy(mailContacts.listId, mailContacts.status)
    return lists.map((l) => {
      const of = (s: ContactStatus) => counts.find((c) => c.listId === l.id && c.status === s)?.n ?? 0
      return { ...l, subscribed: of('subscribed'), pending: of('pending'), unsubscribed: of('unsubscribed') }
    })
  }

  async getList(id: string): Promise<ContactListRow> {
    if (!UUID.test(id)) throw new AudienceError('That list does not exist (any more).')
    const [row] = await (await this.db()).select().from(mailContactLists).where(eq(mailContactLists.id, id)).limit(1)
    if (!row) throw new AudienceError('That list does not exist (any more).')
    return row
  }

  async createList(input: { name: string; doubleOptIn: boolean }, createdBy: string): Promise<ContactListRow> {
    if (!input.name.trim()) throw new AudienceError('Give the list a name.')
    const [row] = await (await this.db())
      .insert(mailContactLists)
      .values({ name: input.name.trim(), doubleOptIn: input.doubleOptIn, createdBy })
      .returning()
    if (!row) throw new Error('mail_contact_lists insert returned no row')
    return row
  }

  async updateList(id: string, patch: { name: string; description: string | null; doubleOptIn: boolean; publicSignup: boolean }): Promise<ContactListRow> {
    if (!patch.name.trim()) throw new AudienceError('Give the list a name.')
    const [row] = await (await this.db())
      .update(mailContactLists)
      .set({ ...patch, name: patch.name.trim(), updatedAt: new Date() })
      .where(eq(mailContactLists.id, id))
      .returning()
    if (!row) throw new AudienceError('That list does not exist (any more).')
    return row
  }

  async deleteList(id: string): Promise<void> {
    await (await this.db()).delete(mailContactLists).where(eq(mailContactLists.id, id))
  }

  // ─── contacts ──────────────────────────────────────────────────────────────

  async contacts(listId: string, status?: ContactStatus): Promise<ContactRow[]> {
    return (await this.db())
      .select()
      .from(mailContacts)
      .where(status ? and(eq(mailContacts.listId, listId), eq(mailContacts.status, status)) : eq(mailContacts.listId, listId))
      .orderBy(desc(mailContacts.createdAt))
      .limit(1000)
  }

  async getContact(id: string): Promise<ContactRow | null> {
    const [row] = await (await this.db()).select().from(mailContacts).where(eq(mailContacts.id, id)).limit(1)
    return row ?? null
  }

  async contactByToken(token: string): Promise<(ContactRow & { listName: string }) | null> {
    const [row] = await (await this.db())
      .select({ contact: mailContacts, listName: mailContactLists.name })
      .from(mailContacts)
      .innerJoin(mailContactLists, eq(mailContacts.listId, mailContactLists.id))
      .where(eq(mailContacts.token, token))
      .limit(1)
    return row ? { ...row.contact, listName: row.listName } : null
  }

  /**
   * Adds a contact. On a double-opt-in list (unless `confirmed`, e.g. imported
   * by the owner with consent) it is pending and gets the confirmation mail;
   * otherwise it is subscribed at once and enters the list's active flows.
   * An existing address is updated, never duplicated or re-subscribed.
   */
  async addContact(listId: string, input: NewContact, opts: { confirmed?: boolean } = {}): Promise<{ contact: ContactRow; created: boolean }> {
    const list = await this.getList(listId)
    const email = normalizeEmail(input.email)
    if (!ADDRESS.test(email)) throw new AudienceError(`"${input.email}" is not an email address.`)
    const db = await this.db()
    const [existing] = await db
      .select()
      .from(mailContacts)
      .where(and(eq(mailContacts.listId, listId), eq(mailContacts.email, email)))
      .limit(1)
    if (existing) {
      const [row] = await db
        .update(mailContacts)
        .set({
          firstName: input.firstName ?? existing.firstName,
          lastName: input.lastName ?? existing.lastName,
          properties: { ...existing.properties, ...(input.properties ?? {}) },
          updatedAt: new Date(),
        })
        .where(eq(mailContacts.id, existing.id))
        .returning()
      return { contact: row!, created: false }
    }
    const pending = list.doubleOptIn && !opts.confirmed
    const [contact] = await db
      .insert(mailContacts)
      .values({
        listId,
        email,
        firstName: input.firstName?.trim() || null,
        lastName: input.lastName?.trim() || null,
        properties: input.properties ?? {},
        status: pending ? 'pending' : 'subscribed',
        token: randomBytes(24).toString('base64url'),
        confirmedAt: pending ? null : this.now(),
      })
      .returning()
    if (!contact) throw new Error('mail_contacts insert returned no row')
    if (pending) await this.sendConfirmation(contact, list)
    else await this.enrollInFlows(contact)
    return { contact, created: true }
  }

  /** "email, first name, last name" per line (header line optional); returns what happened per line. */
  async importContacts(listId: string, csv: string): Promise<{ added: number; updated: number; invalid: string[] }> {
    let added = 0
    let updated = 0
    const invalid: string[] = []
    for (const raw of csv.split(/\r?\n/)) {
      const line = raw.trim()
      if (!line) continue
      const [email = '', firstName, lastName] = line.split(/[,;\t]/).map((c) => c.trim())
      if (email.toLowerCase() === 'email') continue
      if (!ADDRESS.test(email)) {
        invalid.push(line)
        continue
      }
      const out = await this.addContact(listId, { email, firstName: firstName || null, lastName: lastName || null }, { confirmed: true })
      if (out.created) added += 1
      else updated += 1
    }
    return { added, updated, invalid }
  }

  async removeContact(id: string): Promise<void> {
    await (await this.db()).delete(mailContacts).where(eq(mailContacts.id, id))
  }

  private async sendConfirmation(contact: ContactRow, list: ContactListRow): Promise<void> {
    const url = this.confirmUrl(contact.token)
    const name = escapeHtml(list.name)
    await this.deps.owlery.send({
      to: contact.email,
      source: 'double_opt_in',
      contactId: contact.id,
      subject: `Please confirm: ${list.name}`,
      text: `Please confirm that you want to receive mail from "${list.name}":\n\n${url}\n\nIf you did not sign up, ignore this email — you will not hear from us again.`,
      html: `<p>Please confirm that you want to receive mail from <strong>${name}</strong>.</p><p><a href="${escapeHtml(url)}">Yes, subscribe me</a></p><p>If you did not sign up, ignore this email — you will not hear from us again.</p>`,
    })
  }

  /** The confirm link: pending → subscribed (then the list's flows start). */
  async confirm(token: string): Promise<(ContactRow & { listName: string }) | null> {
    const c = await this.contactByToken(token)
    if (!c) return null
    if (c.status === 'pending') {
      await (await this.db())
        .update(mailContacts)
        .set({ status: 'subscribed', confirmedAt: this.now(), updatedAt: new Date() })
        .where(eq(mailContacts.id, c.id))
      const fresh = (await this.getContact(c.id))!
      await this.enrollInFlows(fresh)
      return { ...fresh, listName: c.listName }
    }
    return c
  }

  /** The unsubscribe link and the one-click POST. Idempotent. */
  async unsubscribe(token: string, reason: UnsubscribeReason = 'UNSUBSCRIBED'): Promise<(ContactRow & { listName: string }) | null> {
    const c = await this.contactByToken(token)
    if (!c) return null
    if (c.status !== 'unsubscribed') {
      await (await this.db())
        .update(mailContacts)
        .set({ status: 'unsubscribed', unsubscribeReason: reason, updatedAt: new Date() })
        .where(eq(mailContacts.id, c.id))
    }
    return { ...c, status: 'unsubscribed' }
  }

  /** A hard bounce or complaint unsubscribes the address from every list. */
  async unsubscribeEverywhere(email: string, reason: UnsubscribeReason): Promise<number> {
    const rows = await (await this.db())
      .update(mailContacts)
      .set({ status: 'unsubscribed', unsubscribeReason: reason, updatedAt: new Date() })
      .where(and(eq(mailContacts.email, normalizeEmail(email)), inArray(mailContacts.status, ['pending', 'subscribed'])))
      .returning({ id: mailContacts.id })
    return rows.length
  }

  // ─── flows ─────────────────────────────────────────────────────────────────

  async listFlows(): Promise<(FlowRow & { active: number; completed: number })[]> {
    const db = await this.db()
    const flows = await db.select().from(mailFlows).orderBy(desc(mailFlows.updatedAt))
    const counts = await db
      .select({ flowId: mailFlowEnrollments.flowId, status: mailFlowEnrollments.status, n: count() })
      .from(mailFlowEnrollments)
      .groupBy(mailFlowEnrollments.flowId, mailFlowEnrollments.status)
    const of = (id: string, s: string) => counts.find((c) => c.flowId === id && c.status === s)?.n ?? 0
    return flows.map((f) => ({ ...f, active: of(f.id, 'active'), completed: of(f.id, 'completed') }))
  }

  async getFlow(id: string): Promise<FlowRow & { parsedSteps: FlowStep[] }> {
    if (!UUID.test(id)) throw new AudienceError('That flow does not exist (any more).')
    const [row] = await (await this.db()).select().from(mailFlows).where(eq(mailFlows.id, id)).limit(1)
    if (!row) throw new AudienceError('That flow does not exist (any more).')
    return { ...row, parsedSteps: flowSteps.parse(row.steps) }
  }

  async createFlow(input: { name: string; triggerListId: string | null }, createdBy: string): Promise<FlowRow> {
    if (!input.name.trim()) throw new AudienceError('Give the flow a name.')
    if (input.triggerListId) await this.getList(input.triggerListId)
    const [row] = await (await this.db())
      .insert(mailFlows)
      .values({ name: input.name.trim(), triggerListId: input.triggerListId, steps: [], createdBy })
      .returning()
    if (!row) throw new Error('mail_flows insert returned no row')
    return row
  }

  /** Saves name, trigger and steps. An active flow keeps running with the new steps. */
  async updateFlow(id: string, patch: { name: string; triggerListId: string | null; steps: unknown }): Promise<FlowRow> {
    if (!patch.name.trim()) throw new AudienceError('Give the flow a name.')
    const parsed = flowSteps.safeParse(patch.steps)
    if (!parsed.success) throw new AudienceError('A step is incomplete: every wait needs an amount, every send a template.')
    for (const s of parsed.data) if (s.type === 'send') await this.deps.templates.getTemplate(s.templateId)
    if (patch.triggerListId) await this.getList(patch.triggerListId)
    const [row] = await (await this.db())
      .update(mailFlows)
      .set({ name: patch.name.trim(), triggerListId: patch.triggerListId, steps: parsed.data, updatedAt: new Date() })
      .where(eq(mailFlows.id, id))
      .returning()
    if (!row) throw new AudienceError('That flow does not exist (any more).')
    return row
  }

  async setFlowStatus(id: string, status: FlowStatus): Promise<FlowRow> {
    const flow = await this.getFlow(id)
    if (status === 'active') {
      if (!flow.triggerListId) throw new AudienceError('Choose the list that starts this flow first.')
      if (flow.parsedSteps.length === 0) throw new AudienceError('Add at least one step first.')
    }
    const [row] = await (await this.db())
      .update(mailFlows)
      .set({ status, updatedAt: new Date() })
      .where(eq(mailFlows.id, id))
      .returning()
    // Resuming: waiting enrollments pick up again on the next background pass.
    if (status === 'active') {
      for (const e of await this.enrollments(id, 'active')) {
        await this.deps.enqueue(FLOW_STEP_JOB, { enrollmentId: e.id }, e.waitUntil ?? this.now(), `flow:${e.id}:resume:${e.stepIndex}`)
      }
    }
    return row!
  }

  async deleteFlow(id: string): Promise<void> {
    await (await this.db()).delete(mailFlows).where(eq(mailFlows.id, id))
  }

  async enrollments(flowId: string, status?: EnrollmentRow['status']): Promise<(EnrollmentRow & { email: string })[]> {
    const rows = await (await this.db())
      .select({ e: mailFlowEnrollments, email: mailContacts.email })
      .from(mailFlowEnrollments)
      .innerJoin(mailContacts, eq(mailFlowEnrollments.contactId, mailContacts.id))
      .where(status ? and(eq(mailFlowEnrollments.flowId, flowId), eq(mailFlowEnrollments.status, status)) : eq(mailFlowEnrollments.flowId, flowId))
      .orderBy(desc(mailFlowEnrollments.createdAt))
      .limit(200)
    return rows.map((r) => ({ ...r.e, email: r.email }))
  }

  async flowLog(flowId: string): Promise<FlowLogRow[]> {
    return (await this.db()).select().from(mailFlowLog).where(eq(mailFlowLog.flowId, flowId)).orderBy(desc(mailFlowLog.createdAt)).limit(200)
  }

  private async log(e: EnrollmentRow, event: FlowLogEvent, stepId: string | null, detail: Record<string, unknown> | null = null) {
    await (await this.db()).insert(mailFlowLog).values({ flowId: e.flowId, enrollmentId: e.id, stepId, event, detail })
  }

  private async setEnrollment(id: string, patch: Partial<typeof mailFlowEnrollments.$inferInsert>): Promise<EnrollmentRow> {
    const [row] = await (await this.db())
      .update(mailFlowEnrollments)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(mailFlowEnrollments.id, id))
      .returning()
    return row!
  }

  /** A newly subscribed contact enters every active flow its list triggers (once per flow). */
  async enrollInFlows(contact: ContactRow): Promise<number> {
    if (contact.status !== 'subscribed') return 0
    const db = await this.db()
    const flows = await db
      .select()
      .from(mailFlows)
      .where(and(eq(mailFlows.triggerListId, contact.listId), eq(mailFlows.status, 'active')))
    let n = 0
    for (const flow of flows) {
      const [e] = await db
        .insert(mailFlowEnrollments)
        .values({ id: randomUUID(), flowId: flow.id, contactId: contact.id })
        .onConflictDoNothing()
        .returning()
      if (!e) continue
      await this.log(e, 'entered', null, { email: contact.email })
      await this.deps.enqueue(FLOW_STEP_JOB, { enrollmentId: e.id }, this.now(), `flow:${e.id}:start`)
      n += 1
    }
    return n
  }

  /**
   * Runs one enrollment as far as it can go now (job kind flow_step): sends
   * until the next wait, the end, or an exit. A send that Amazon refuses
   * throws, so the job retries the same step; a template that cannot render
   * (missing variable) exits the enrollment with the reason in the log.
   */
  async runEnrollment(enrollmentId: string): Promise<void> {
    const [found] = await (await this.db()).select().from(mailFlowEnrollments).where(eq(mailFlowEnrollments.id, enrollmentId)).limit(1)
    if (!found || found.status !== 'active') return
    let e = found
    const flow = await this.getFlow(e.flowId)
    if (flow.status !== 'active') return // paused: resumed by setFlowStatus
    for (let guard = 0; guard < 100; guard++) {
      const contact = await this.getContact(e.contactId)
      if (!contact) return
      const action = nextAction(flow.parsedSteps, { stepIndex: e.stepIndex, waitUntil: e.waitUntil }, contact, this.now())
      switch (action.type) {
        case 'complete':
          await this.setEnrollment(e.id, { status: 'completed', waitUntil: null })
          await this.log(e, 'completed', null)
          return
        case 'exit':
          await this.setEnrollment(e.id, { status: 'exited' })
          await this.log(e, 'exited', flow.parsedSteps[e.stepIndex]?.id ?? null, { reason: action.reason })
          return
        case 'start_wait':
          e = await this.setEnrollment(e.id, { waitUntil: action.until })
          await this.log(e, 'waiting', action.step.id, { until: action.until.toISOString() })
          await this.deps.enqueue(FLOW_STEP_JOB, { enrollmentId: e.id }, action.until, waitKey(e.id, e.stepIndex, action.until))
          return
        case 'still_waiting':
          await this.deps.enqueue(FLOW_STEP_JOB, { enrollmentId: e.id }, action.until, waitKey(e.id, e.stepIndex, action.until))
          return
        case 'wait_over':
          e = await this.setEnrollment(e.id, { stepIndex: e.stepIndex + 1, waitUntil: null })
          continue
        case 'send': {
          const variables: Record<string, string> = {
            ...contact.properties,
            email: contact.email,
            ...(contact.firstName ? { firstName: contact.firstName } : {}),
            ...(contact.lastName ? { lastName: contact.lastName } : {}),
            unsubscribe_url: this.unsubscribeUrl(contact.token),
          }
          try {
            const sent = await this.deps.templates.send({
              templateId: action.step.templateId,
              to: contact.email,
              variables,
              source: 'flow',
              flowId: flow.id,
              contactId: contact.id,
              headers: this.unsubscribeHeaders(contact.token),
              ...(action.step.from ? { from: action.step.from } : {}),
            })
            await this.log(e, 'email_sent', action.step.id, { messageId: sent.id, status: sent.status })
          } catch (err) {
            if (err instanceof TemplateRenderError) {
              await this.setEnrollment(e.id, { status: 'exited' })
              await this.log(e, 'error', action.step.id, { message: err.message })
              return
            }
            await this.log(e, 'error', action.step.id, { message: err instanceof Error ? err.message : String(err), retrying: true })
            throw err
          }
          e = await this.setEnrollment(e.id, { stepIndex: e.stepIndex + 1, waitUntil: null })
          continue
        }
      }
    }
    throw new Error(`flow enrollment ${enrollmentId} did not settle within 100 steps`)
  }

  /** The job handler registered on the platform. */
  async runJob(job: JobRow): Promise<void> {
    const id = job.payload.enrollmentId
    if (typeof id !== 'string') throw new Error('flow_step job without enrollmentId')
    await this.runEnrollment(id)
  }

  /** Every platform table of this stage, children first (e2e harness reset). */
  async clearAll(): Promise<void> {
    const db = await this.db()
    await db.delete(mailFlowLog)
    await db.delete(mailFlowEnrollments)
    await db.delete(mailFlows)
    await db.delete(mailContacts)
    await db.delete(mailContactLists)
  }
}
