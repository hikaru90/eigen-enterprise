import { describe, expect, it } from 'vitest'
import { contactHistory, createContact, deleteContact, logContact } from './service'
import { agent, fixture, user } from './test-fixtures'

/**
 * Contact history ("Kontaktverlauf", Contribute b8a87a25): every logged
 * contact is kept, with the follow-up it answered and the one it set, and the
 * timeline shows mail with the person's addresses from the mailboxes the
 * viewer may read — the mail port decides that, the service only asks with
 * the viewer's own id.
 */

const tz = 'Europe/Berlin'

describe('contact history', () => {
  it('keeps every logged contact: the day, how it went, the follow-up it answered and the one it set', async () => {
    const f = fixture()
    const mara = await createContact(f.deps, user('ana'), { name: 'Mara Voss', nextFollowUpOn: '2026-11-10', nextStep: 'Send the deck' })
    await logContact(f.deps, user('ana'), mara.id, { on: '2026-11-11', note: 'She liked the deck.', nextFollowUpOn: '2026-11-20', nextStep: 'Call' })
    await logContact(f.deps, user('ben'), mara.id, { on: '2026-11-12' }).catch(() => null) // Ben can't see Ana's private contact
    await logContact(f.deps, user('ana'), mara.id, { on: '2026-11-12' })

    const h = await contactHistory(f.deps, user('ana'), mara.id, { timeZone: tz, mailWith: f.mailWith })
    // Added on the 12th (fixture clock), in touch on the 11th and the 12th.
    expect(h.map((i) => [i.kind, i.day])).toEqual([
      ['logged', '2026-11-12'],
      ['added', '2026-11-12'],
      ['logged', '2026-11-11'],
    ])
    const [latest, first] = h.filter((i) => i.kind === 'logged')
    expect(first).toMatchObject({
      by: 'Ana Lind',
      note: 'She liked the deck.',
      answered: { on: '2026-11-10', step: 'Send the deck' },
      next: { on: '2026-11-20', step: 'Call' },
    })
    expect(latest).toMatchObject({ note: null, answered: { on: '2026-11-20', step: 'Call' }, next: null })
    expect(h.find((i) => i.kind === 'added')).toMatchObject({ by: 'Ana Lind' })
    expect(f.store.log).toHaveLength(2)
  })

  it('a note that is too long fails loud and logs nothing', async () => {
    const f = fixture()
    const mara = await createContact(f.deps, user('ana'), { name: 'Mara Voss' })
    await expect(logContact(f.deps, user('ana'), mara.id, { on: '2026-11-11', note: 'x'.repeat(2001) })).rejects.toMatchObject({
      code: 'invalid',
    })
    expect(f.store.log).toHaveLength(0)
    expect((await contactHistory(f.deps, user('ana'), mara.id, { timeZone: tz, mailWith: f.mailWith })).map((i) => i.kind)).toEqual(['added'])
  })

  it('the agent logging a contact is in the history as the agent', async () => {
    const f = fixture()
    const mara = await createContact(f.deps, user('ana'), { name: 'Mara Voss' }, { shared: true })
    await logContact(f.deps, agent, mara.id, { on: '2026-11-11' })
    const h = await contactHistory(f.deps, user('ana'), mara.id, { timeZone: tz, mailWith: f.mailWith })
    expect(h.find((i) => i.kind === 'logged')).toMatchObject({ by: 'the agent' })
  })

  it('asks the mail port with the viewer’s own id and the contact’s email addresses, and places mail by day in the viewer’s zone', async () => {
    const f = fixture()
    const mara = await createContact(
      f.deps,
      user('ana'),
      {
        name: 'Mara Voss',
        channels: [
          { type: 'email', value: 'Mara@Northwind.example' },
          { type: 'phone', value: '+49 30 1234' },
          { type: 'email', value: 'mara@home.example' },
        ],
      },
      { shared: true },
    )
    f.mail.items = [
      {
        id: 'm1',
        direction: 'received',
        via: { kind: 'mailbox', address: 'ben@co.example' },
        subject: 'Hello',
        snippet: 'Hi Ben',
        // 23:30 UTC on the 11th is the 12th in Berlin.
        at: new Date('2026-11-11T23:30:00Z'),
        href: '/m/email/inbox?box=b&m=m1',
      },
    ]
    const h = await contactHistory(f.deps, user('ben'), mara.id, { timeZone: tz, mailWith: f.mailWith })
    expect(f.mail.calls).toEqual([{ userId: 'ben', addresses: ['mara@northwind.example', 'mara@home.example'] }])
    expect(h.find((i) => i.kind === 'mail')).toMatchObject({ kind: 'mail', id: 'm1', day: '2026-11-12', direction: 'received', subject: 'Hello' })
  })

  it('no email address: the mail port is not asked', async () => {
    const f = fixture()
    const mara = await createContact(f.deps, user('ana'), { name: 'Mara Voss' })
    await contactHistory(f.deps, user('ana'), mara.id, { timeZone: tz, mailWith: f.mailWith })
    expect(f.mail.calls).toEqual([])
  })

  it('orders by day, newest first; on one day the newest first', async () => {
    const f = fixture()
    const mara = await createContact(f.deps, user('ana'), {
      name: 'Mara Voss',
      channels: [{ type: 'email', value: 'mara@northwind.example' }],
    })
    await logContact(f.deps, user('ana'), mara.id, { on: '2026-11-05' })
    f.mail.items = [
      { id: 'old', direction: 'sent', via: { kind: 'company', status: 'DELIVERED' }, subject: 'Old', snippet: null, at: new Date('2026-11-01T10:00:00Z'), href: '/m/email/logs/old' },
      { id: 'new', direction: 'received', via: { kind: 'mailbox', address: 'ana@co.example' }, subject: 'New', snippet: null, at: new Date('2026-11-05T15:00:00Z'), href: '/x' },
    ]
    const h = await contactHistory(f.deps, user('ana'), mara.id, { timeZone: tz, mailWith: f.mailWith })
    // Added on the 12th; the entry is about the 5th but was logged later (the fixture clock), so on the 5th it
    // comes before the mail of that afternoon.
    expect(h.map((i) => [i.id, i.day])).toEqual([
      [mara.id, '2026-11-12'],
      [f.store.log[0]!.id, '2026-11-05'],
      ['new', '2026-11-05'],
      ['old', '2026-11-01'],
    ])
  })

  it('a contact the viewer may not see is not found, and the mail port is never asked', async () => {
    const f = fixture()
    const mara = await createContact(f.deps, user('ana'), { name: 'Mara Voss', channels: [{ type: 'email', value: 'mara@northwind.example' }] })
    await expect(contactHistory(f.deps, user('ben'), mara.id, { timeZone: tz, mailWith: f.mailWith })).rejects.toMatchObject({ code: 'not_found' })
    expect(f.mail.calls).toEqual([])
  })

  it('is for people: the agent has no path to anyone’s mail', async () => {
    const f = fixture()
    const mara = await createContact(f.deps, user('ana'), { name: 'Mara Voss' })
    await expect(contactHistory(f.deps, agent, mara.id, { timeZone: tz, mailWith: f.mailWith })).rejects.toMatchObject({ code: 'forbidden' })
  })

  it('a bad time zone fails loud', async () => {
    const f = fixture()
    const mara = await createContact(f.deps, user('ana'), { name: 'Mara Voss' })
    await expect(contactHistory(f.deps, user('ana'), mara.id, { timeZone: 'Mars/Olympus', mailWith: f.mailWith })).rejects.toThrow()
  })

  it('deleting the contact deletes its history', async () => {
    const f = fixture()
    const mara = await createContact(f.deps, user('ana'), { name: 'Mara Voss' })
    await logContact(f.deps, user('ana'), mara.id, { on: '2026-11-11' })
    await deleteContact(f.deps, user('ana'), mara.id)
    expect(f.store.log).toHaveLength(0)
  })
})
