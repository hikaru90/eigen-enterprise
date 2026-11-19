import { describe, expect, it, vi } from 'vitest'
import { ASSISTANT_ATTACHMENT_LIMITS } from '$lib/components/assistant/attachments'
import { LlmHttpError, LlmNotConfiguredError } from '$lib/server/llm/errors'
import {
  AssistantAttachmentError,
  attachmentMetadata,
  composeAgentMessage,
  parseChatAttachments,
  readAssistantAttachment,
} from './attachments'

/**
 * Attachments in the assistant chat (Contribute: "Allow users to attach documents in the AI
 * assistant"): a text file is read as is, a PDF or an image is read by the company's model
 * through the gateway; every refusal is a plain sentence, never a silent cut.
 */

const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a])
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00])

function modelSays(content: string, finishReason = 'stop') {
  return vi.fn(async () => ({ choices: [{ message: { content }, finish_reason: finishReason }] }))
}

function bytesOf(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

describe('readAssistantAttachment', () => {
  it('reads a text file as is — no model call', async () => {
    const complete = modelSays('unused')
    const attachment = await readAssistantAttachment(
      { complete },
      { userId: 'u1', filename: ' notes.md ', bytes: bytesOf('# Plan\n\nShip the bakery site.') },
    )
    expect(attachment).toEqual({
      name: 'notes.md',
      kind: 'text',
      sizeBytes: bytesOf('# Plan\n\nShip the bakery site.').length,
      text: '# Plan\n\nShip the bakery site.',
    })
    expect(complete).not.toHaveBeenCalled()
  })

  it('hands a PDF to the company model as a file part and keeps the text it read', async () => {
    const complete = modelSays('Quarterly report\n\nRevenue grew 12%.')
    const attachment = await readAssistantAttachment(
      { complete },
      { userId: 'u1', filename: 'q3.pdf', bytes: PDF },
    )
    expect(attachment).toEqual({
      name: 'q3.pdf',
      kind: 'pdf',
      sizeBytes: PDF.length,
      text: 'Quarterly report\n\nRevenue grew 12%.',
    })
    expect(complete).toHaveBeenCalledTimes(1)
    const call = complete.mock.calls[0]![0] as {
      userId: string
      messages: Array<{ role: string; attachments?: unknown[] }>
    }
    expect(call.userId).toBe('u1')
    const user = call.messages.find((m) => m.role === 'user')
    expect(user?.attachments).toEqual([
      { type: 'pdf', filename: 'q3.pdf', base64: Buffer.from(PDF).toString('base64') },
    ])
  })

  it('hands an image to the model as an image part', async () => {
    const complete = modelSays('A whiteboard sketch of the homepage.')
    const attachment = await readAssistantAttachment(
      { complete },
      { userId: 'u1', filename: 'sketch.png', bytes: PNG },
    )
    expect(attachment.kind).toBe('image')
    const call = complete.mock.calls[0]![0] as { messages: Array<{ attachments?: unknown[] }> }
    expect(call.messages.at(-1)?.attachments).toEqual([
      { type: 'image', mime: 'image/png', base64: Buffer.from(PNG).toString('base64') },
    ])
  })

  it('refuses a file it cannot read (binary, e.g. a Word file) with a plain sentence', async () => {
    const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff, 0xfe, 0x00])
    const err = await readAssistantAttachment(
      { complete: modelSays('x') },
      { userId: 'u1', filename: 'brief.docx', bytes: zip },
    ).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(AssistantAttachmentError)
    expect((err as AssistantAttachmentError).status).toBe(415)
    expect((err as Error).message).toContain('“brief.docx”')
    expect((err as Error).message).toMatch(/PDF/)
  })

  it('refuses an empty file and a nameless one', async () => {
    await expect(
      readAssistantAttachment(
        { complete: modelSays('x') },
        { userId: 'u1', filename: 'a.txt', bytes: new Uint8Array() },
      ),
    ).rejects.toMatchObject({ status: 400, message: '“a.txt” is empty.' })
    await expect(
      readAssistantAttachment(
        { complete: modelSays('x') },
        { userId: 'u1', filename: '  ', bytes: bytesOf('x') },
      ),
    ).rejects.toMatchObject({ status: 400 })
  })

  it('refuses a PDF over its size limit before any model call', async () => {
    const complete = modelSays('x')
    const big = new Uint8Array(ASSISTANT_ATTACHMENT_LIMITS.maxBytes.pdf + 1)
    big.set(PDF)
    const err = await readAssistantAttachment(
      { complete },
      { userId: 'u1', filename: 'huge.pdf', bytes: big },
    ).catch((e: unknown) => e)
    expect((err as AssistantAttachmentError).status).toBe(413)
    expect((err as Error).message).toBe('“huge.pdf” is 10.0 MB; PDFs can be at most 10 MB.')
    expect(complete).not.toHaveBeenCalled()
  })

  it('refuses text longer than one attachment can carry — never a silent cut', async () => {
    const text = 'a'.repeat(ASSISTANT_ATTACHMENT_LIMITS.maxTextChars + 1)
    await expect(
      readAssistantAttachment(
        { complete: modelSays('x') },
        { userId: 'u1', filename: 'log.txt', bytes: bytesOf(text) },
      ),
    ).rejects.toMatchObject({ status: 413 })
    await expect(
      readAssistantAttachment(
        { complete: modelSays(text) },
        { userId: 'u1', filename: 'book.pdf', bytes: PDF },
      ),
    ).rejects.toMatchObject({ status: 413 })
  })

  it('fails loud when the model stopped before it finished reading', async () => {
    await expect(
      readAssistantAttachment(
        { complete: modelSays('Chapter 1 …', 'length') },
        { userId: 'u1', filename: 'book.pdf', bytes: PDF },
      ),
    ).rejects.toMatchObject({ status: 413 })
  })

  it('says so when the AI provider cannot read files, or none is set up', async () => {
    const rejecting = vi.fn(async () => {
      throw new LlmHttpError(400, 'unsupported content part: file')
    })
    const err = await readAssistantAttachment(
      { complete: rejecting },
      { userId: 'u1', filename: 'q3.pdf', bytes: PDF },
    ).catch((e: unknown) => e)
    expect((err as AssistantAttachmentError).status).toBe(422)
    expect((err as Error).message).toContain('could not read “q3.pdf”')
    expect((err as Error).message).not.toContain('unsupported content part')

    const unconfigured = vi.fn(async () => {
      throw new LlmNotConfiguredError('LLM_BASE_URL missing')
    })
    await expect(
      readAssistantAttachment(
        { complete: unconfigured },
        { userId: 'u1', filename: 'q3.pdf', bytes: PDF },
      ),
    ).rejects.toMatchObject({ status: 503 })
  })
})

describe('parseChatAttachments', () => {
  const one = { name: 'notes.md', kind: 'text', sizeBytes: 12, text: 'Ship it.' }

  it('accepts no attachments and well-formed ones', () => {
    expect(parseChatAttachments(undefined)).toEqual([])
    expect(parseChatAttachments([one])).toEqual([one])
  })

  it('refuses malformed, too many, or too much text in one message', () => {
    expect(() => parseChatAttachments([{ name: 'x' }])).toThrow(AssistantAttachmentError)
    expect(() => parseChatAttachments('nope')).toThrow(AssistantAttachmentError)
    const many = Array.from({ length: ASSISTANT_ATTACHMENT_LIMITS.maxFiles + 1 }, () => one)
    expect(() => parseChatAttachments(many)).toThrow(/at most 5 files/)
    const chunk = 'a'.repeat(ASSISTANT_ATTACHMENT_LIMITS.maxTextChars)
    const heavy = Array.from(
      { length: Math.ceil(ASSISTANT_ATTACHMENT_LIMITS.maxTotalTextChars / chunk.length) + 1 },
      (_, i) => ({ ...one, name: `${i}.txt`, text: chunk }),
    ).slice(0, ASSISTANT_ATTACHMENT_LIMITS.maxFiles)
    expect(() => parseChatAttachments(heavy)).toThrow(AssistantAttachmentError)
  })
})

describe('composeAgentMessage', () => {
  it('is the message alone without attachments', () => {
    expect(composeAgentMessage('hello', [])).toBe('hello')
  })

  it('appends each file with its name, kind and full text', () => {
    const composed = composeAgentMessage('Summarise these.', [
      { name: 'notes.md', kind: 'text', sizeBytes: 2048, text: 'Ship the bakery site.' },
      { name: 'q3.pdf', kind: 'pdf', sizeBytes: 1_258_291, text: 'Revenue grew 12%.' },
    ])
    expect(composed.startsWith('Summarise these.\n\n')).toBe(true)
    expect(composed).toContain('<attached_file name="notes.md" type="text file" size="2 KB">')
    expect(composed).toContain('Ship the bakery site.')
    expect(composed).toContain('<attached_file name="q3.pdf" type="PDF" size="1.2 MB">')
    expect(composed).toContain('Revenue grew 12%.')
    expect(composed.match(/<\/attached_file>/g)).toHaveLength(2)
  })
})

describe('attachmentMetadata', () => {
  it('keeps name, kind and size for the chips — never the text', () => {
    expect(attachmentMetadata([])).toBeNull()
    expect(
      attachmentMetadata([{ name: 'q3.pdf', kind: 'pdf', sizeBytes: 9, text: 'secret numbers' }]),
    ).toEqual({ attachments: [{ name: 'q3.pdf', kind: 'pdf', sizeBytes: 9 }] })
  })
})
