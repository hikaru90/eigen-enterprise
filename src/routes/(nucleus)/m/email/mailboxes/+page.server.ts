import type { Actions, PageServerLoad } from './$types'
import { inboxDeps } from '../../../../../../modules/email/inbox/live'
import {
  addAlias,
  assignPersonalMailbox,
  createSharedMailbox,
  mailboxAdmin,
  readableMailboxes,
  removeAlias,
  setMailboxDisabled,
} from '../../../../../../modules/email/inbox/service'
import { syncMailReceiving } from '../../../../../../modules/email/platform/receiving-sync'
import { act, field, requireAdmin, requireMember } from '../access.server'

/**
 * After every successful change the SES receipt rules follow the mailboxes. A
 * failed sync keeps the change; the admin sees Amazon's reason (it is also
 * stored on the receiving state, shown under Setup › Account).
 */
async function synced<T extends Record<string, unknown>>(out: T): Promise<T & { receivingError?: string }> {
  const receivingError = await syncMailReceiving()
  return receivingError ? { ...out, receivingError } : out
}

/**
 * Email › Setup › Mailboxes (plan/email-inbox.md S1): the owner and admins
 * assign receiving addresses — a personal one per member, shared ones per
 * group, aliases — and see counts and sizes, never mail content. A member sees
 * the addresses they read.
 */
export const load: PageServerLoad = async ({ locals }) => {
  const me = await requireMember(locals)
  const deps = await inboxDeps()
  const mine = (await readableMailboxes(deps, me.userId)).map((b) => ({
    address: b.address,
    aliases: b.aliases,
    kind: b.kind,
    displayName: b.displayName,
    disabled: b.disabled,
  }))
  return { admin: me.isAdmin ? await mailboxAdmin(deps, me.userId) : null, mine }
}

export const actions: Actions = {
  assign: async ({ locals, request }) => {
    const me = await requireAdmin(locals)
    const form = await request.formData()
    return act('assign', async () => {
      const box = await assignPersonalMailbox(await inboxDeps(), me.userId, {
        memberId: field(form, 'memberId'),
        localPart: field(form, 'localPart'),
        domainId: field(form, 'domainId'),
        displayName: field(form, 'displayName') || null,
      })
      return synced({ address: box.address })
    })
  },
  shared: async ({ locals, request }) => {
    const me = await requireAdmin(locals)
    const form = await request.formData()
    return act('shared', async () => {
      const box = await createSharedMailbox(await inboxDeps(), me.userId, {
        groupId: field(form, 'groupId'),
        localPart: field(form, 'localPart'),
        domainId: field(form, 'domainId'),
        displayName: field(form, 'displayName') || null,
      })
      return synced({ address: box.address })
    })
  },
  alias: async ({ locals, request }) => {
    const me = await requireAdmin(locals)
    const form = await request.formData()
    return act('alias', async () => {
      await addAlias(await inboxDeps(), me.userId, {
        mailboxId: field(form, 'mailboxId'),
        localPart: field(form, 'localPart'),
        domainId: field(form, 'domainId'),
      })
      return synced({})
    })
  },
  removeAlias: async ({ locals, request }) => {
    const me = await requireAdmin(locals)
    const form = await request.formData()
    return act('removeAlias', async () => {
      await removeAlias(await inboxDeps(), me.userId, { address: field(form, 'address') })
      return synced({})
    })
  },
  disable: async ({ locals, request }) => {
    const me = await requireAdmin(locals)
    const form = await request.formData()
    return act('disable', async () => {
      await setMailboxDisabled(await inboxDeps(), me.userId, { mailboxId: field(form, 'mailboxId'), disabled: true })
      return synced({})
    })
  },
  enable: async ({ locals, request }) => {
    const me = await requireAdmin(locals)
    const form = await request.formData()
    return act('enable', async () => {
      await setMailboxDisabled(await inboxDeps(), me.userId, { mailboxId: field(form, 'mailboxId'), disabled: false })
      return synced({})
    })
  },
}
