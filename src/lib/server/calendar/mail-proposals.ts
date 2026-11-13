import type { StoredMailRef } from '../../../../modules/calendar/mail-scan'
import type { InvitationMail, ProposalDeps, ProposalMail, ProposalMailRef } from '../../../../modules/calendar/proposals'
import type { UserJobQueue } from '$lib/server/db/schema'

/**
 * The wiring between Calendar and Email for appointments from mail (K7) and
 * their invitation (K4) — outside modules/, since modules never import each
 * other (modules/boundaries.spec.ts): the proposals table over the app pool,
 * the inbox for the holder's own mail and for sending from their mailbox, the
 * job queue for the reading.
 */

let depsPromise: Promise<ProposalDeps> | null = null

/** Translates the mail side's refusals (its plain errors) into InvitationNotSent; anything else stays a real failure. */
async function sendFromMailbox(userId: string, mail: InvitationMail): Promise<void> {
  const { sendDeps } = await import('../../../../modules/email/inbox/live')
  const { sendInvitation } = await import('../../../../modules/email/inbox/send')
  const { InboxError } = await import('../../../../modules/email/inbox/errors')
  const { MailNotConfiguredError, MailSetupError } = await import('$lib/server/mail/company-mail')
  const { InvitationNotSent } = await import('../../../../modules/calendar/proposals')
  try {
    await sendInvitation(await sendDeps(), userId, mail)
  } catch (err) {
    if (err instanceof InboxError || err instanceof MailSetupError || err instanceof MailNotConfiguredError) {
      throw new InvitationNotSent(err.message, { cause: err })
    }
    throw err
  }
}

const liveMail: ProposalMail = {
  async personalMail(userId, messageId): Promise<ProposalMailRef | null> {
    const { inboxDeps } = await import('../../../../modules/email/inbox/live')
    const { readableMailbox } = await import('../../../../modules/email/inbox/service')
    const { InboxError } = await import('../../../../modules/email/inbox/errors')
    const deps = await inboxDeps()
    const message = await deps.store.getMessage(messageId)
    if (!message) return null
    const box = await deps.store.getMailbox(message.mailboxId)
    // The holder's own personal mailbox only (a shared one is never read for appointments).
    if (!box || box.kind !== 'personal' || box.ownerUserId !== userId) return null
    let view: Awaited<ReturnType<typeof readableMailbox>>
    try {
      view = await readableMailbox(deps, userId, box.id)
    } catch (err) {
      // Not (or no longer) theirs to read — e.g. the member left the company.
      if (err instanceof InboxError && err.code === 'not_found') return null
      throw err
    }
    return { mailbox: { id: view.id, address: view.address, aliases: view.aliases }, message }
  },
  sendInvitation: sendFromMailbox,
}

export function proposalDeps(): Promise<ProposalDeps> {
  depsPromise ??= (async (): Promise<ProposalDeps> => {
    const { appSql, createScopedDrizzle } = await import('$lib/server/db')
    const { calendarDeps } = await import('../../../../modules/calendar/live')
    const { dbProposalStore } = await import('../../../../modules/calendar/proposal-db-store')
    return { calendar: await calendarDeps(), proposals: dbProposalStore(createScopedDrizzle(appSql)), mail: liveMail }
  })().catch((err) => {
    depsPromise = null
    throw err
  })
  return depsPromise
}

/** Whether the Calendar plugin is on now (the kernel's cached activation set; pages ask before showing proposals). */
export async function calendarOn(): Promise<boolean> {
  const { appKernel } = await import('$lib/server/boot')
  return (await (await appKernel()).activations.get('calendar')) === true
}

/** The inbox ingest's hook: queue the appointment reading of a mail stored in a personal Inbox. */
export async function queueAppointmentScan(mail: StoredMailRef): Promise<void> {
  const { queueScan, CALENDAR_MAIL_PROPOSAL_JOB } = await import('../../../../modules/calendar/mail-scan')
  const { pluginOn } = await import('$lib/server/plugins/background')
  const { enqueueUserJob } = await import('$lib/server/job-queue/enqueue')
  await queueScan(
    {
      pluginOn: (id, work) => pluginOn(id, work),
      enqueue: async (job) => {
        await enqueueUserJob({ userId: job.userId, jobType: CALENDAR_MAIL_PROPOSAL_JOB, runAfter: new Date(), dedupeKey: job.dedupeKey, payload: job.payload })
      },
    },
    mail,
  )
}

/** The job queue's handler for calendar_mail_proposal. */
export async function processCalendarMailProposalJob(job: Pick<UserJobQueue, 'userId' | 'payload'>): Promise<void> {
  const { runScanJob } = await import('../../../../modules/calendar/mail-scan')
  const { scanMail } = await import('../../../../modules/calendar/proposals')
  const { liveAppointmentChat } = await import('../../../../modules/calendar/mail-extract')
  const { timeZoneFor } = await import('../../../../modules/calendar/live')
  const { pluginOn } = await import('$lib/server/plugins/background')
  const deps = await proposalDeps()
  const outcome = await runScanJob(
    {
      pluginOn: (id, work) => pluginOn(id, work),
      scan: (j) => scanMail({ ...deps, chat: liveAppointmentChat, timeZoneFor }, j),
      log: (line, fields) => console.info(line, fields),
    },
    job,
  )
  if (outcome === 'filed') console.info('[calendar] appointment proposal filed', { messageId: String(job.payload.messageId) })
}
