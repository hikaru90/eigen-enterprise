import type {
  CreateGraphicPostInput,
  SocialNetwork,
  SocialPost,
  UpdatePostInput,
} from '../../../../../modules/brand/social/types'

/**
 * The Social tab's calls onto /api/brand/social. Every failure becomes an
 * Error carrying the server's plain sentence (the tab shows it as it is).
 */

export type CaptionSuggestions = {
  postId: string
  locale: string | null
  voice: boolean
  captions: Partial<Record<SocialNetwork, string[]>>
}

export type SocialApi = {
  createGraphic(input: CreateGraphicPostInput): Promise<SocialPost>
  upload(form: FormData): Promise<SocialPost>
  update(postId: string, patch: Omit<UpdatePostInput, 'postId'>): Promise<SocialPost>
  remove(postId: string): Promise<void>
  suggestCaptions(postId: string, body: { networks?: SocialNetwork[]; locale?: string; brief?: string }): Promise<CaptionSuggestions>
}

async function read<T>(res: Response): Promise<T> {
  if (res.ok) return (res.status === 204 ? undefined : await res.json()) as T
  let message = `The request failed (HTTP ${res.status}).`
  try {
    const body = (await res.json()) as { message?: unknown }
    if (typeof body.message === 'string' && body.message) message = body.message
  } catch {
    // The status sentence above stands when the body is not JSON.
  }
  throw new Error(message)
}

const jsonInit = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

export function socialApi(f: typeof fetch = fetch): SocialApi {
  return {
    createGraphic: async (input) => read(await f('/api/brand/social/posts', jsonInit('POST', input))),
    upload: async (form) => read(await f('/api/brand/social/posts', { method: 'POST', body: form })),
    update: async (postId, patch) => read(await f(`/api/brand/social/posts/${postId}`, jsonInit('PATCH', patch))),
    remove: async (postId) => read(await f(`/api/brand/social/posts/${postId}`, { method: 'DELETE' })),
    suggestCaptions: async (postId, body) => read(await f(`/api/brand/social/posts/${postId}/captions`, jsonInit('POST', body))),
  }
}

/** The assistant's composer draft behind "Create with assistant" (?prefill=, never auto-sent). */
export const ASSISTANT_PREFILL = 'Create a social media post in our brand style for Brand › Social about: '

export const mediaUrl =(mediaId: string, download = false) => `/api/brand/social/media/${mediaId}${download ? '?download=1' : ''}`
