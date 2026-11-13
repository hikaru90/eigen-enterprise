import { describe, expect, it } from 'vitest'
import { ContactsError } from './errors'
import { contactsAction, contactsLoad, formContactInput, formLogInput, personActor } from './http'

const form = (entries: Array<[string, string]>) => {
  const f = new FormData()
  for (const [k, v] of entries) f.append(k, v)
  return f
}

describe('contacts forms', () => {
  it('reads every field; the empty channel row is not a channel; custom tags are comma separated', () => {
    const input = formContactInput(
      form([
        ['name', 'Mara Voss'],
        ['organisation', ''],
        ['channelType', 'email'],
        ['channelValue', 'mara@northwind.example'],
        ['channelType', 'phone'],
        ['channelValue', '   '],
        ['tag', 'investor'],
        ['tag', 'partner'],
        ['customTags', ' seed round,, Berlin '],
        ['nextFollowUpOn', '2026-11-20'],
      ]),
    )
    expect(input).toEqual({
      name: 'Mara Voss',
      organisation: '',
      title: '',
      channels: [{ type: 'email', value: 'mara@northwind.example' }],
      metHow: '',
      whyRelevant: '',
      tags: ['investor', 'partner', 'seed round', 'Berlin'],
      lastContactedOn: '',
      nextFollowUpOn: '2026-11-20',
      nextStep: '',
    })
  })

  it('refuses channel types and values that do not pair up', () => {
    expect(() => formContactInput(form([['name', 'A'], ['channelType', 'email']]))).toThrow(ContactsError)
  })

  it('reads the log form', () => {
    expect(formLogInput(form([['on', '2026-11-12'], ['note', 'Good talk'], ['nextStep', 'Call']]))).toEqual({
      on: '2026-11-12',
      note: 'Good talk',
      nextFollowUpOn: '',
      nextStep: 'Call',
    })
  })
})

describe('contacts page seam', () => {
  it('sends signed-out visitors to /login', () => {
    expect(() => personActor(null)).toThrow(expect.objectContaining({ status: 302, location: '/login' }))
    expect(personActor({ id: 'ana' })).toEqual({ kind: 'user', userId: 'ana' })
  })

  it('a contacts failure comes back to the form with its status; anything else is thrown', async () => {
    const out = await contactsAction('save', async () => {
      throw new ContactsError('invalid', 'Give the contact a name.')
    })
    expect(out).toMatchObject({ status: 400, data: { action: 'save', id: null, error: 'Give the contact a name.' } })
    const logged = await contactsAction('log', async () => Promise.reject(new ContactsError('invalid', 'bad day')), 'c1')
    expect(logged).toMatchObject({ status: 400, data: { action: 'log', id: 'c1', error: 'bad day' } })
    await expect(contactsAction('save', async () => Promise.reject(new Error('db down')))).rejects.toThrow('db down')
  })

  it('a contact you cannot see is a 404 page', async () => {
    await expect(
      contactsLoad(async () => {
        throw new ContactsError('not_found', 'contact not found')
      }),
    ).rejects.toMatchObject({ status: 404, body: { message: 'No such contact' } })
  })
})
