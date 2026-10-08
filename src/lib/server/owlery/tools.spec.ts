import { describe, expect, it, vi } from 'vitest'
import { runAddContactTool, runListContactsTool, runSendMailTool } from './tools'

const mailEnv = {
  OWLERY_API_KEY: 'us_test',
  OWLERY_BASE_URL: 'https://owlery.example',
  OWLERY_EMAIL_FROM: 'hello@eigenenterprise.example',
}
const contactBookEnv = { ...mailEnv, OWLERY_CONTACT_BOOK_ID: 'cb_1' }

function okFetch(body: unknown) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }))
}

describe('runSendMailTool', () => {
  it('delegates to sendTransactionalEmail and fails loud when unconfigured', async () => {
    await expect(
      runSendMailTool({}, { to: 'a@b.co', subject: 's', html: 'h', text: 't' }),
    ).rejects.toThrow(/not configured/)
  })

  it('returns the emailId from the API', async () => {
    const fetchImpl = okFetch({ emailId: 'em_1' })
    await expect(
      runSendMailTool(mailEnv, { to: 'a@b.co', subject: 's', html: 'h', text: 't' }, fetchImpl as unknown as typeof fetch),
    ).resolves.toEqual({ emailId: 'em_1' })
  })
})

describe('runAddContactTool', () => {
  it('delegates to createOwleryContact and fails loud when unconfigured', async () => {
    await expect(
      runAddContactTool(mailEnv, { email: 'a@b.co' }),
    ).rejects.toThrow(/not configured/)
  })

  it('returns the contactId from the API', async () => {
    const fetchImpl = okFetch({ contactId: 'ct_1' })
    await expect(
      runAddContactTool(contactBookEnv, { email: 'a@b.co' }, fetchImpl as unknown as typeof fetch),
    ).resolves.toEqual({ contactId: 'ct_1' })
  })
})

describe('runListContactsTool', () => {
  it('fails loud when the contact book is not configured', async () => {
    await expect(runListContactsTool(mailEnv)).rejects.toThrow(/not configured/)
  })

  it('GETs the contact book contacts endpoint with bearer auth and returns the parsed body', async () => {
    const fetchImpl = okFetch({ data: [{ contactId: 'ct_1', email: 'a@b.co' }] })
    const result = await runListContactsTool(contactBookEnv, fetchImpl as unknown as typeof fetch)

    expect(result).toEqual({ data: [{ contactId: 'ct_1', email: 'a@b.co' }] })
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://owlery.example/api/v1/contactBooks/cb_1/contacts',
      { headers: { Authorization: 'Bearer us_test' } },
    )
  })

  it('throws with API error detail on non-OK responses', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ message: 'book gone' }), { status: 404 }),
    )
    await expect(runListContactsTool(contactBookEnv, fetchImpl as unknown as typeof fetch)).rejects.toThrow(
      /Owlery contact list failed \(404\): book gone/,
    )
  })

  it('throws on a non-JSON success body instead of returning null', async () => {
    const fetchImpl = vi.fn(async () => new Response('not json', { status: 200 }))
    await expect(runListContactsTool(contactBookEnv, fetchImpl as unknown as typeof fetch)).rejects.toThrow(
      /non-JSON body/,
    )
  })
})
