import { describe, expect, it, vi } from 'vitest'
import { LlmHttpError, LlmNotConfiguredError } from '$lib/server/llm/errors'
import {
  APPOINTMENT_LOG_CONTEXT,
  APPOINTMENT_MAX_ATTEMPTS,
  buildAppointmentMessages,
  extractAppointment,
  parseAppointmentOutput,
  type AppointmentChat,
  type AppointmentMail,
} from './mail-extract'

const answer = (json: unknown) => ({ choices: [{ message: { content: typeof json === 'string' ? json : JSON.stringify(json) } }] })

function fakeChat(...answers: unknown[]) {
  const queue = [...answers]
  return vi.fn<AppointmentChat>(async () => {
    if (queue.length === 0) throw new Error('fake gateway has no answer queued')
    const next = queue.shift()
    if (next instanceof Error) throw next
    return next
  })
}

const mail: AppointmentMail = {
  subject: 'Re: Kurzer Call?',
  from: { name: 'Mara Voss', address: 'mara@sender.example' },
  to: [{ name: 'Ana Lind', address: 'ana.lind@example.com' }],
  cc: [{ name: 'Sam', address: 'sam@sender.example' }],
  receivedAt: new Date('2026-11-12T09:00:05Z'),
  text: 'Donnerstag 15 Uhr passt mir, ich schicke den Link: https://meet.example/abc',
  html: null,
}
const reader = { name: 'Ana Lind', addresses: ['ana.lind@example.com', 'ana@example.com'], timeZone: 'Europe/Berlin' }
const now = new Date('2026-11-12T09:01:00Z')
const ctx = { mail, reader, now }

const hit = {
  appointment: {
    title: 'Call with Mara Voss',
    start: '2026-11-19T15:00',
    end: '2026-11-19T15:30',
    time_zone: 'Europe/Berlin',
    location: null,
    call: 'https://meet.example/abc',
    participants: [
      { email: 'Mara@Sender.example', name: 'Mara Voss' },
      { email: 'sam@sender.example', name: null },
    ],
  },
}

describe('appointment reading: the prompt', () => {
  it('gives the model the schema, the reader, their zone and now; the mail goes in as data', () => {
    const [system, user] = buildAppointmentMessages(ctx)
    expect(system!.role).toBe('system')
    expect(system!.content).toContain('"appointment"')
    expect(system!.content).toContain('"participants"')
    expect(user!.content).toContain('Europe/Berlin')
    expect(user!.content).toContain('2026-11-12T09:01:00.000Z')
    const data = JSON.parse(user!.content.slice(user!.content.indexOf('{')))
    expect(data).toMatchObject({
      subject: 'Re: Kurzer Call?',
      from: { name: 'Mara Voss', address: 'mara@sender.example' },
      reader: { name: 'Ana Lind', addresses: ['ana.lind@example.com', 'ana@example.com'] },
      body_text: mail.text,
    })
  })

  it('sends the HTML when the mail has no text part, and cuts a very long body', () => {
    const [, user] = buildAppointmentMessages({ ...ctx, mail: { ...mail, text: null, html: `<p>${'a'.repeat(50_000)}</p>` } })
    const data = JSON.parse(user!.content.slice(user!.content.indexOf('{')))
    expect(data.body_text).toBeUndefined()
    expect(data.body_html.length).toBeLessThanOrEqual(20_000)
  })
})

describe('appointment reading: validating the answer', () => {
  it('a hit becomes UTC times in the zone, the guests from the mail (lower case), the call kept', () => {
    expect(parseAppointmentOutput(answer(hit), ctx)).toEqual({
      title: 'Call with Mara Voss',
      startsAt: new Date('2026-11-19T14:00:00Z'),
      endsAt: new Date('2026-11-19T14:30:00Z'),
      timeZone: 'Europe/Berlin',
      location: null,
      call: 'https://meet.example/abc',
      attendees: [
        { email: 'mara@sender.example', name: 'Mara Voss' },
        { email: 'sam@sender.example', name: null },
      ],
    })
  })

  it('no appointment is null', () => {
    expect(parseAppointmentOutput(answer({ appointment: null }), ctx)).toBeNull()
  })

  it('an appointment already over by now is no proposal', () => {
    const past = { appointment: { ...hit.appointment, start: '2026-11-11T15:00', end: '2026-11-11T15:30' } }
    expect(parseAppointmentOutput(answer(past), ctx)).toBeNull()
  })

  it('refuses guests that are not on the mail, or the reader themself', () => {
    const stranger = { appointment: { ...hit.appointment, participants: [{ email: 'eve@else.example', name: null }] } }
    expect(() => parseAppointmentOutput(answer(stranger), ctx)).toThrow(/not on the mail/)
    const self = { appointment: { ...hit.appointment, participants: [{ email: 'ana@example.com', name: null }] } }
    expect(() => parseAppointmentOutput(answer(self), ctx)).toThrow(/reader/)
  })

  it('refuses a missing guest list, a bad zone, a non-time and an end before the start', () => {
    expect(() => parseAppointmentOutput(answer({ appointment: { ...hit.appointment, participants: [] } }), ctx)).toThrow()
    expect(() => parseAppointmentOutput(answer({ appointment: { ...hit.appointment, time_zone: 'Berlin' } }), ctx)).toThrow(/time zone/)
    expect(() => parseAppointmentOutput(answer({ appointment: { ...hit.appointment, start: 'Thursday 3pm' } }), ctx)).toThrow(/wall time/)
    expect(() => parseAppointmentOutput(answer({ appointment: { ...hit.appointment, end: '2026-11-19T14:00' } }), ctx)).toThrow(/after/)
    expect(() => parseAppointmentOutput(answer({ appointment: { ...hit.appointment, extra: 1 } }), ctx)).toThrow()
    expect(() => parseAppointmentOutput(answer('not json'), ctx)).toThrow()
  })
})

describe('appointment reading: the call', () => {
  it('one gateway call on the reader’s account, JSON mode, temperature 0, cost-tracked context', async () => {
    const chat = fakeChat(answer(hit))
    const out = await extractAppointment(chat, { userId: 'ana', ...ctx })
    expect(out?.title).toBe('Call with Mara Voss')
    expect(chat).toHaveBeenCalledTimes(1)
    expect(chat.mock.calls[0]![0]).toMatchObject({ userId: 'ana', temperature: 0, responseFormat: 'json_object', logContext: APPOINTMENT_LOG_CONTEXT })
  })

  it('an unreadable answer is retried, then fails loud', async () => {
    const ok = fakeChat(answer('nope'), answer(hit))
    expect((await extractAppointment(ok, { userId: 'ana', ...ctx }))?.title).toBe('Call with Mara Voss')
    const bad = fakeChat(...Array.from({ length: APPOINTMENT_MAX_ATTEMPTS }, () => answer('nope')))
    await expect(extractAppointment(bad, { userId: 'ana', ...ctx })).rejects.toThrow(/couldn’t be read/)
    expect(bad).toHaveBeenCalledTimes(APPOINTMENT_MAX_ATTEMPTS)
  })

  it('no AI provider and a provider refusal are not retried', async () => {
    const none = fakeChat(new LlmNotConfiguredError('no provider'))
    await expect(extractAppointment(none, { userId: 'ana', ...ctx })).rejects.toBeInstanceOf(LlmNotConfiguredError)
    expect(none).toHaveBeenCalledTimes(1)
    const refused = fakeChat(new LlmHttpError(429, 'slow down'))
    await expect(extractAppointment(refused, { userId: 'ana', ...ctx })).rejects.toBeInstanceOf(LlmHttpError)
    expect(refused).toHaveBeenCalledTimes(1)
  })
})
