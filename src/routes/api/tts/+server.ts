import type { RequestHandler } from './$types'
import { error, json } from '@sveltejs/kit'
import { synthesizeSpeech } from '$lib/server/llm/tts-client'

/**
 * The assistant's voice: gateway TTS (OpenRouter, `tts-client.ts`) for signed-in users. The browser
 * speechSynthesis robot voice is gone — a failing gateway means silence on
 * the client, and the provider's exact error here.
 */
export const POST: RequestHandler = async (event) => {
  const user = event.locals.user
  if (!user) error(401, 'Unauthorized')

  const body = (await event.request.json().catch(() => null)) as { text?: unknown } | null
  const text = typeof body?.text === 'string' ? body.text : ''
  if (!text.trim()) error(400, 'missing text')
  if (text.length > 4000) error(400, 'text exceeds 4000 chars')

  try {
    const audio = await synthesizeSpeech({ userId: user.id, text })
    return new Response(audio as unknown as BodyInit, {
      headers: {
        'content-type': 'audio/mpeg',
        'cache-control': 'private, no-store',
      },
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Speech synthesis failed'
    console.error('tts failed', { userId: user.id, message })
    return json({ error: message }, { status: 500 })
  }
}
