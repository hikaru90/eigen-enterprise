import type { AiTaskId } from '$lib/ai-usage/tasks'
import type { ChatAttachment, ChatMessage } from './llm-client'
import { visionModel } from './model-pool'
import type { SlotTarget } from './slots'

/**
 * Seeing images and PDFs (wish a4a5a3ad: a co-worker "cannot look at your new images"). The
 * company's chat model may read text only (DeepSeek Flash does), so an image or PDF goes to a
 * model of the pool that reads them: the chat model itself when it does, else the provider's
 * vision pick (model-pool.ts visionModel). Every call goes through the gateway, so its cost
 * lands on the cost ledger under the caller's task. A bring-your-own-key provider outside the
 * pool routes by its own chat model, as before; a model without image input answers with an
 * HTTP error (LlmHttpError), never a silent text-only call.
 */

export type ImageMime = 'image/png' | 'image/jpeg' | 'image/webp'

/** An image's type from its format signature (never its name): PNG, JPEG or WebP, else null. */
export function detectImageMime(bytes: Uint8Array): ImageMime | null {
  const at = (i: number) => bytes[i]
  if (bytes.length >= 8 && at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) return 'image/png'
  if (bytes.length >= 3 && at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return 'image/jpeg'
  if (
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF' &&
    String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP'
  )
    return 'image/webp'
  return null
}

/** True when the bytes start with a PDF signature. */
export function isPdfBytes(bytes: Uint8Array): boolean {
  return bytes.length >= 5 && String.fromCharCode(...bytes.subarray(0, 5)) === '%PDF-'
}

export type VisionDeps = {
  resolveChat: (userId: string) => Promise<SlotTarget>
  complete: (input: {
    userId: string
    messages: ChatMessage[]
    temperature?: number
    maxTokens?: number
    task: AiTaskId
    modelOverride?: string
  }) => Promise<unknown>
}

/** Live calls run on the company's provider (company-provider.ts), whoever the caller is. */
async function onCompany<T>(fn: () => Promise<T>): Promise<T> {
  const { onCompanyProvider } = await import('./company-provider')
  return onCompanyProvider(fn)
}

export const liveVisionDeps: VisionDeps = {
  resolveChat: (userId) => onCompany(async () => (await import('./slots')).resolveSlot('chat', userId)),
  complete: (input) => onCompany(async () => (await import('./llm-client')).llmChatCompletion(input)),
}

/**
 * The pool model an image or PDF goes to for this company, or undefined for a provider outside
 * the pool (its own chat model reads, as it always did).
 */
export async function resolveVisionModel(
  userId: string,
  deps: Pick<VisionDeps, 'resolveChat'> = liveVisionDeps,
): Promise<string | undefined> {
  const target = await deps.resolveChat(userId)
  if (!target.pool || !target.model) return undefined
  return visionModel(target.model, target.pool)
}

const LOOK_INSTRUCTIONS = [
  'You look at one image or PDF for an AI colleague who cannot see it. It will work only from what you write, so be complete and faithful.',
  'First write out every piece of text it contains, in its original language. Then describe what it shows: layout, colours, people, objects, charts and their values, in plain sentences.',
  'When a question is given, answer it from what you see after the description. Never invent what is not there.',
].join('\n')

const LOOK_MAX_TOKENS = 8_000

export class VisionReadError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'VisionReadError'
  }
}

/** What a vision model sees in one image or PDF (text first, then a description; `question` answered). */
export async function llmLookAt(
  input: { userId: string; task: AiTaskId; name: string; attachment: ChatAttachment; question?: string },
  deps: VisionDeps = liveVisionDeps,
): Promise<{ text: string; model: string | null }> {
  const model = await resolveVisionModel(input.userId, deps)
  const question = input.question?.trim()
  const response = await deps.complete({
    userId: input.userId,
    messages: [
      { role: 'system', content: LOOK_INSTRUCTIONS },
      {
        role: 'user',
        content: `The file is “${input.name}”.${question ? `\nQuestion: ${question}` : ''}`,
        attachments: [input.attachment],
      },
    ],
    temperature: 0,
    maxTokens: LOOK_MAX_TOKENS,
    task: input.task,
    ...(model ? { modelOverride: model } : {}),
  })
  const choice = (response as { choices?: Array<{ message?: { content?: unknown }; finish_reason?: unknown }> })?.choices?.[0]
  const content = choice?.message?.content
  if (typeof content !== 'string') throw new Error('gateway response is missing choices[0].message.content (string)')
  if (choice?.finish_reason === 'length') throw new VisionReadError(`“${input.name}” holds too much to read in one look.`)
  const text = content.trim()
  if (!text) throw new VisionReadError(`Nothing could be read from “${input.name}”.`)
  return { text, model: model ?? null }
}
