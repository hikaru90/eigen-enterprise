import { describe, expect, it } from 'vitest'
import { CallsError } from '../../../../modules/calls/errors'
import { fixture } from '../../../../modules/calls/test-fixtures'
import * as transcriptRoute from './[id]/transcript/+server'
import * as transcriptionRoute from './[id]/transcription/+server'
import * as guestTranscriptRoute from './guest/[token]/transcript/+server'
import * as guestTranscriptionRoute from './guest/[token]/transcription/+server'

/** Call transcripts over HTTP: chunks in (raw audio), my switch, reading the transcript. One in-memory service. */
function wire() {
  const f = fixture()
  const service = async () => f.service
  for (const r of [
    transcriptRoute,
    transcriptionRoute,
    guestTranscriptRoute,
    guestTranscriptionRoute,
  ])
    r._deps.service = service
  return f
}

const ev = (over: Record<string, unknown>) => over as never
const as = (id: string | null, extra: Record<string, unknown> = {}) => ({
  locals: { user: id ? { id } : null },
  ...extra,
})
const chunk = (headers: Record<string, string> = {}, bytes = new Uint8Array([1, 2, 3])) =>
  new Request('http://os.test/api/calls/x/transcript', {
    method: 'POST',
    body: bytes,
    headers: {
      'content-type': 'audio/webm;codecs=opus',
      'x-chunk-duration-ms': '30000',
      ...headers,
    },
  })
const json = (b: unknown) =>
  new Request('http://os.test/api/calls/x/transcription', {
    method: 'POST',
    body: JSON.stringify(b),
    headers: { 'content-type': 'application/json' },
  })

/** The status of a handler that may throw SvelteKit's error() (an HttpError with .status). */
async function statusOf(run: () => Promise<Response>): Promise<number> {
  try {
    return (await run()).status
  } catch (err) {
    const status = (err as { status?: unknown }).status
    if (typeof status === 'number') return status
    throw err
  }
}

async function liveDm(f: ReturnType<typeof wire>) {
  const call = await f.service.start(f.user('ann'), { contextKind: 'dm', contextId: 'dm-ann-ben' })
  await f.service.accept('ben', call.id)
  for (const identity of ['ann', 'ben'])
    await f.service.applyWebhook({
      kind: 'participant_joined',
      room: `ee-call-${call.id}`,
      identity,
    })
  return call.id
}

describe('/api/calls/[id]/transcript', () => {
  it('signed in only — before the body is read', async () => {
    wire()
    const res = await transcriptRoute.POST(ev(as(null, { params: { id: 'x' }, request: chunk() })))
    expect(res.status).toBe(401)
    expect((await transcriptRoute.GET(ev(as(null, { params: { id: 'x' } })))).status).toBe(401)
  })

  it('POST: a raw audio chunk with its duration → my segment', async () => {
    const f = wire()
    const id = await liveDm(f)
    f.speech.next('Hallo Ben')
    const res = await transcriptRoute.POST(ev(as('ann', { params: { id }, request: chunk() })))
    expect(res.status).toBe(200)
    const out = (await res.json()) as { segment: { speakerName: string; text: string } }
    expect(out.segment).toMatchObject({ speakerName: 'Ann Example', text: 'Hallo Ben' })
    expect(f.speech.calls[0]!.audio).toEqual({ bytes: new Uint8Array([1, 2, 3]), format: 'webm' })
  })

  it('POST refuses a chunk without a sane duration or with a non-audio type (400); outsiders get 404', async () => {
    const f = wire()
    const id = await liveDm(f)
    expect(
      await statusOf(() =>
        transcriptRoute.POST(
          ev(as('ann', { params: { id }, request: chunk({ 'x-chunk-duration-ms': '' }) })),
        ),
      ),
    ).toBe(400)
    expect(
      await statusOf(() =>
        transcriptRoute.POST(
          ev(as('ann', { params: { id }, request: chunk({ 'x-chunk-duration-ms': '30s' }) })),
        ),
      ),
    ).toBe(400)
    expect(
      await statusOf(() =>
        transcriptRoute.POST(
          ev(as('ann', { params: { id }, request: chunk({ 'x-chunk-duration-ms': '90000' }) })),
        ),
      ),
    ).toBe(400)
    expect(
      await statusOf(() =>
        transcriptRoute.POST(
          ev(as('ann', { params: { id }, request: chunk({ 'content-type': 'text/plain' }) })),
        ),
      ),
    ).toBe(400)
    expect(
      await statusOf(() =>
        transcriptRoute.POST(ev(as('cat', { params: { id }, request: chunk() }))),
      ),
    ).toBe(404)
    expect(f.speech.calls).toEqual([])
  })

  it('POST: no speech to text on this server → 503 with code unavailable (the call itself goes on)', async () => {
    const f = wire()
    const id = await liveDm(f)
    f.deps.speech = async () => {
      throw new CallsError('unavailable', 'The owner sets up an OpenRouter key for speech')
    }
    const { createCallsService } = await import('../../../../modules/calls/service')
    const service = createCallsService(f.deps)
    transcriptRoute._deps.service = async () => service
    const res = await transcriptRoute.POST(ev(as('ann', { params: { id }, request: chunk() })))
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({
      error: 'The owner sets up an OpenRouter key for speech',
      code: 'unavailable',
      agent: expect.objectContaining({
        attempted: 'Transcribing a chunk of my microphone in a call',
        code: 'CallsError',
      }),
    })
  })

  it('GET: the merged transcript for someone who was in the call', async () => {
    const f = wire()
    const id = await liveDm(f)
    f.speech.next('eins')
    await transcriptRoute.POST(ev(as('ann', { params: { id }, request: chunk() })))
    const res = await transcriptRoute.GET(ev(as('ben', { params: { id } })))
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const out = (await res.json()) as { segments: { text: string }[] }
    expect(out.segments.map((s) => s.text)).toEqual(['eins'])
    expect((await transcriptRoute.GET(ev(as('cat', { params: { id } })))).status).toBe(404)
  })
})

describe('/api/calls/[id]/transcription', () => {
  it('POST { on }: my own switch, the call back', async () => {
    const f = wire()
    const id = await liveDm(f)
    const res = await transcriptionRoute.POST(
      ev(as('ben', { params: { id }, request: json({ on: false }) })),
    )
    expect(res.status).toBe(200)
    const out = (await res.json()) as {
      call: { participants: { userId: string; transcribing: boolean }[] }
    }
    expect(out.call.participants.find((p) => p.userId === 'ben')?.transcribing).toBe(false)
    expect(
      (
        await transcriptionRoute.POST(
          ev(as('ben', { params: { id }, request: json({ on: 'no' }) })),
        )
      ).status,
    ).toBe(400)
    expect(
      (await transcriptionRoute.POST(ev(as(null, { params: { id }, request: json({ on: true }) }))))
        .status,
    ).toBe(401)
  })
})

describe('guest transcript routes', () => {
  it('a guest sends chunks and switches their own transcription with the link alone', async () => {
    const f = wire()
    const out = await f.service.schedule(f.user('ann'), {
      guests: ['kunde@example.org'],
      timeZone: 'Europe/Berlin',
    })
    const token = decodeURIComponent(out.invitations[0]!.url.split('/join/')[1]!)
    await f.service.guestJoin(token, 'Kim Kunde')
    f.speech.next('Guten Tag')
    const sent = await guestTranscriptRoute.POST(ev({ params: { token }, request: chunk() }))
    expect(sent.status).toBe(200)
    expect(((await sent.json()) as { segment: { speakerName: string } }).segment.speakerName).toBe(
      'Kim Kunde',
    )
    const off = await guestTranscriptionRoute.POST(
      ev({ params: { token }, request: json({ on: false }) }),
    )
    expect(off.status).toBe(200)
    expect(
      (await guestTranscriptRoute.POST(ev({ params: { token }, request: chunk() }))).status,
    ).toBe(409)
    expect(
      await statusOf(() =>
        guestTranscriptRoute.POST(ev({ params: { token: 'x'.repeat(30) }, request: chunk() })),
      ),
    ).toBe(404)
  })
})
