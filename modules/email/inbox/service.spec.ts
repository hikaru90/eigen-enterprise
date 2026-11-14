import { describe, expect, it } from 'vitest'
import {
  addAlias,
  assignPersonalMailbox,
  createSharedMailbox,
  getMessage,
  listMessages,
  mailboxAdmin,
  readableMailboxes,
  receivingAddresses,
  removeAlias,
  setMailboxDisabled,
} from './service'
import { fixture, message } from './test-fixtures'

async function anaWithMailbox() {
  const f = fixture()
  const box = await assignPersonalMailbox(f.deps, 'olga', { memberId: 'ana', localPart: 'Ana.Lind', domainId: 'd-1' })
  return { ...f, box }
}

describe('assigning a personal mailbox', () => {
  it('gives the member their address on a verified domain and audits it without content', async () => {
    const { box, events } = await anaWithMailbox()
    expect(box).toMatchObject({ address: 'ana.lind@example.com', kind: 'personal', ownerUserId: 'ana', aliases: [] })
    expect(events).toEqual([
      {
        type: 'email.mailbox_assigned',
        principalId: 'olga',
        payload: { mailboxId: box.id, address: 'ana.lind@example.com', kind: 'personal', memberId: 'ana' },
      },
    ])
  })

  it('is for the owner and admins only', async () => {
    const { deps } = fixture()
    await expect(assignPersonalMailbox(deps, 'ana', { memberId: 'ana', localPart: 'ana', domainId: 'd-1' })).rejects.toMatchObject({
      code: 'forbidden',
    })
    await expect(assignPersonalMailbox(deps, 'adam', { memberId: 'ben', localPart: 'ben', domainId: 'd-1' })).resolves.toMatchObject({
      address: 'ben@example.com',
    })
  })

  it('refuses an address that is taken (as a primary or an alias)', async () => {
    const { deps, box } = await anaWithMailbox()
    await addAlias(deps, 'olga', { mailboxId: box.id, localPart: 'ana', domainId: 'd-1' })
    await expect(assignPersonalMailbox(deps, 'olga', { memberId: 'ben', localPart: 'ana.lind', domainId: 'd-1' })).rejects.toMatchObject({
      code: 'taken',
      message: 'ana.lind@example.com is already in use. Pick another address.',
    })
    await expect(assignPersonalMailbox(deps, 'olga', { memberId: 'ben', localPart: 'ana', domainId: 'd-1' })).rejects.toMatchObject({
      code: 'taken',
    })
  })

  it('gives each member one personal mailbox (more addresses are aliases)', async () => {
    const { deps } = await anaWithMailbox()
    await expect(assignPersonalMailbox(deps, 'olga', { memberId: 'ana', localPart: 'ana2', domainId: 'd-1' })).rejects.toMatchObject({
      code: 'invalid',
      message: 'Ana Lind already has a mailbox (ana.lind@example.com). Add another address to it as an alias.',
    })
  })

  it('needs a company member, a verified domain and a valid address', async () => {
    const { deps } = fixture()
    await expect(assignPersonalMailbox(deps, 'olga', { memberId: 'zed', localPart: 'zed', domainId: 'd-1' })).rejects.toMatchObject({
      code: 'not_found',
      message: 'No such member.',
    })
    await expect(assignPersonalMailbox(deps, 'olga', { memberId: 'ana', localPart: 'ana', domainId: 'd-pending' })).rejects.toMatchObject({
      code: 'invalid',
      message: 'Pick a verified domain. Domains are added and verified under Setup › Account.',
    })
    await expect(assignPersonalMailbox(deps, 'olga', { memberId: 'ana', localPart: 'an..a', domainId: 'd-1' })).rejects.toMatchObject({
      code: 'invalid',
    })
  })
})

describe('shared mailboxes', () => {
  it('belong to a group and are read by its members', async () => {
    const { deps } = fixture()
    const box = await createSharedMailbox(deps, 'olga', { groupId: 'g-sales', localPart: 'sales', domainId: 'd-1', displayName: ' Sales team ' })
    expect(box).toMatchObject({ address: 'sales@example.com', kind: 'shared', groupId: 'g-sales', displayName: 'Sales team' })
    expect((await readableMailboxes(deps, 'sam')).map((b) => b.address)).toEqual(['sales@example.com'])
    expect(await readableMailboxes(deps, 'ben')).toEqual([])
  })

  it('need an existing group', async () => {
    const { deps } = fixture()
    await expect(createSharedMailbox(deps, 'olga', { groupId: 'g-x', localPart: 'x', domainId: 'd-1' })).rejects.toMatchObject({
      code: 'not_found',
      message: 'No such group.',
    })
  })
})

describe('who reads a mailbox', () => {
  it('a personal inbox: only its member — not the owner, not an admin, not another member', async () => {
    const { deps, store, box } = await anaWithMailbox()
    const m = message(box.id)
    await store.insertMessage(m)

    expect((await listMessages(deps, 'ana', { mailboxId: box.id, folder: 'inbox' })).map((x) => x.id)).toEqual([m.id])
    expect(await getMessage(deps, 'ana', m.id)).toMatchObject({ id: m.id, textBody: 'Hi Ana, how are you?' })

    for (const who of ['olga', 'adam', 'ben']) {
      await expect(listMessages(deps, who, { mailboxId: box.id, folder: 'inbox' })).rejects.toMatchObject({ code: 'not_found' })
      await expect(getMessage(deps, who, m.id)).rejects.toMatchObject({ code: 'not_found' })
    }
  })

  it('a shared inbox: members of its group only, and it follows group membership', async () => {
    const { deps, store } = fixture()
    const box = await createSharedMailbox(deps, 'olga', { groupId: 'g-sales', localPart: 'sales', domainId: 'd-1' })
    const m = message(box.id)
    await store.insertMessage(m)
    expect(await getMessage(deps, 'sam', m.id)).toMatchObject({ id: m.id })
    await expect(getMessage(deps, 'olga', m.id)).rejects.toMatchObject({ code: 'not_found' })
    await expect(getMessage(deps, 'ben', m.id)).rejects.toMatchObject({ code: 'not_found' })
  })

  it('someone who left the company reads nothing, even their own old mailbox', async () => {
    const { deps, store, box } = await anaWithMailbox()
    await store.insertMessage(message(box.id))
    deps.roleOf = async (id) => (id === 'ana' ? null : 'owner')
    await expect(listMessages(deps, 'ana', { mailboxId: box.id, folder: 'inbox' })).rejects.toMatchObject({ code: 'not_found' })
    expect(await readableMailboxes(deps, 'ana')).toEqual([])
  })

  it('lists my mailboxes: my own first, then shared ones by address', async () => {
    const { deps } = await anaWithMailbox()
    await createSharedMailbox(deps, 'olga', { groupId: 'g-sales', localPart: 'sales', domainId: 'd-1' })
    await createSharedMailbox(deps, 'olga', { groupId: 'g-sales', localPart: 'info', domainId: 'd-1' })
    expect((await readableMailboxes(deps, 'ana')).map((b) => b.address)).toEqual([
      'ana.lind@example.com',
      'info@example.com',
      'sales@example.com',
    ])
  })

  it('lists one folder, newest first', async () => {
    const { deps, store, box } = await anaWithMailbox()
    await store.insertMessage(message(box.id, { id: 'old', receivedAt: new Date('2026-11-10T00:00:00Z') }))
    await store.insertMessage(message(box.id, { id: 'new', receivedAt: new Date('2026-11-11T00:00:00Z') }))
    await store.insertMessage(message(box.id, { id: 'junk', folder: 'spam' }))
    expect((await listMessages(deps, 'ana', { mailboxId: box.id, folder: 'inbox' })).map((x) => x.id)).toEqual(['new', 'old'])
    expect((await listMessages(deps, 'ana', { mailboxId: box.id, folder: 'spam' })).map((x) => x.id)).toEqual(['junk'])
  })
})

describe('the Mailboxes admin view', () => {
  it('shows addresses, who holds them and counts — never subjects or senders', async () => {
    const { deps, store, box } = await anaWithMailbox()
    await addAlias(deps, 'olga', { mailboxId: box.id, localPart: 'ana', domainId: 'd-1' })
    await store.insertMessage(message(box.id, { sizeBytes: 1000 }))
    await store.insertMessage(message(box.id, { sizeBytes: 500, readAt: new Date() }))

    const view = await mailboxAdmin(deps, 'adam')
    expect(view.mailboxes).toEqual([
      {
        id: box.id,
        address: 'ana.lind@example.com',
        aliases: ['ana@example.com'],
        kind: 'personal',
        holder: 'Ana Lind',
        displayName: null,
        disabled: false,
        messages: 2,
        unread: 1,
        sizeBytes: 1500,
      },
    ])
    expect(JSON.stringify(view)).not.toContain('Hello')
    expect(JSON.stringify(view)).not.toContain('mara@sender.example')
  })

  it('suggests firstname.lastname for members without a mailbox, and offers verified domains and groups', async () => {
    const { deps } = await anaWithMailbox()
    const view = await mailboxAdmin(deps, 'olga')
    expect(view.members).toEqual([
      { id: 'adam', name: 'Adam Admin', suggested: 'adam.admin', mailbox: null },
      { id: 'ana', name: 'Ana Lind', suggested: 'ana.lind', mailbox: 'ana.lind@example.com' },
      { id: 'ben', name: 'Ben Ode', suggested: 'ben.ode', mailbox: null },
      { id: 'olga', name: 'Olga Owner', suggested: 'olga.owner', mailbox: null },
      { id: 'sam', name: 'Sam Süß', suggested: 'sam.suess', mailbox: null },
    ])
    expect(view.domains).toEqual([{ id: 'd-1', name: 'example.com' }])
    expect(view.groups).toEqual([
      { id: 'g-dev', name: 'Dev' },
      { id: 'g-sales', name: 'Sales' },
    ])
  })

  it('is for the owner and admins only', async () => {
    const { deps } = fixture()
    await expect(mailboxAdmin(deps, 'ana')).rejects.toMatchObject({ code: 'forbidden' })
  })
})

describe('aliases, disabling and the receiving list', () => {
  it('an alias delivers into the mailbox; removing it frees the address', async () => {
    const { deps, box } = await anaWithMailbox()
    await addAlias(deps, 'olga', { mailboxId: box.id, localPart: 'a.lind', domainId: 'd-1' })
    expect(await receivingAddresses(deps)).toEqual(['a.lind@example.com', 'ana.lind@example.com'])
    await removeAlias(deps, 'olga', { address: 'A.Lind@example.com ' })
    expect(await receivingAddresses(deps)).toEqual(['ana.lind@example.com'])
  })

  it('a primary address can’t be removed as an alias', async () => {
    const { deps } = await anaWithMailbox()
    await expect(removeAlias(deps, 'olga', { address: 'ana.lind@example.com' })).rejects.toMatchObject({
      code: 'invalid',
      message: 'ana.lind@example.com is the mailbox’s main address, not an alias.',
    })
  })

  it('a disabled mailbox receives nothing new but stays readable', async () => {
    const { deps, store, box } = await anaWithMailbox()
    await addAlias(deps, 'olga', { mailboxId: box.id, localPart: 'ana', domainId: 'd-1' })
    const m = message(box.id)
    await store.insertMessage(m)
    await setMailboxDisabled(deps, 'olga', { mailboxId: box.id, disabled: true })
    expect(await receivingAddresses(deps)).toEqual([])
    expect(await getMessage(deps, 'ana', m.id)).toMatchObject({ id: m.id })
    expect((await readableMailboxes(deps, 'ana'))[0]).toMatchObject({ disabled: true })
    await setMailboxDisabled(deps, 'olga', { mailboxId: box.id, disabled: false })
    expect(await receivingAddresses(deps)).toEqual(['ana.lind@example.com', 'ana@example.com'])
  })

  it('alias and disable changes are owner/admin only', async () => {
    const { deps, box } = await anaWithMailbox()
    await expect(addAlias(deps, 'ana', { mailboxId: box.id, localPart: 'x', domainId: 'd-1' })).rejects.toMatchObject({ code: 'forbidden' })
    await expect(setMailboxDisabled(deps, 'ana', { mailboxId: box.id, disabled: true })).rejects.toMatchObject({ code: 'forbidden' })
  })
})
