import { randomBytes } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { CompanyMail, MailNotConfiguredError, type CompanyMailRow } from './company-mail'

function setup() {
  let row: CompanyMailRow | null = null
  const store = { read: async () => row, write: async (r: CompanyMailRow) => void (row = r) }
  const send = vi.fn(async () => undefined)
  const key = randomBytes(32)
  const mail = new CompanyMail({ store, key: () => key, send })
  return { mail, send, rowOf: () => row }
}

const input = { baseUrl: 'https://owlery.example/', emailFrom: 'hi@kindred.test', apiKey: 'ow_secret_key', contactBookId: null, testRecipient: 'owner@kindred.test', updatedBy: 'u1' }

describe('CompanyMail', () => {
  it('is not configured until the owner saves settings, and sending says so', async () => {
    const { mail } = setup()
    expect(await mail.isConfigured()).toBe(false)
    await expect(mail.send({ to: 'a@b.co', subject: 's', text: 't', html: 'h' })).rejects.toBeInstanceOf(MailNotConfiguredError)
  })

  it('saves only after a test email went out, and never stores the key in plain text', async () => {
    const { mail, send, rowOf } = setup()
    await mail.saveVerified(input)
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ OWLERY_API_KEY: 'ow_secret_key', OWLERY_BASE_URL: 'https://owlery.example' }), expect.objectContaining({ to: 'owner@kindred.test' }))
    expect(JSON.stringify(rowOf())).not.toContain('ow_secret_key')
    expect(await mail.settings()).toMatchObject({ apiKey: 'ow_secret_key', emailFrom: 'hi@kindred.test' })
  })

  it('a failing test email saves nothing', async () => {
    const { mail, send, rowOf } = setup()
    send.mockRejectedValueOnce(new Error('Owlery 401'))
    await expect(mail.saveVerified(input)).rejects.toThrow('Owlery 401')
    expect(rowOf()).toBeNull()
  })

  it('rejects obviously incomplete settings before sending anything', async () => {
    const { mail, send } = setup()
    await expect(mail.saveVerified({ ...input, apiKey: ' ' })).rejects.toThrow(/API key/)
    await expect(mail.saveVerified({ ...input, baseUrl: 'owlery.example' })).rejects.toThrow(/https/)
    expect(send).not.toHaveBeenCalled()
  })
})
