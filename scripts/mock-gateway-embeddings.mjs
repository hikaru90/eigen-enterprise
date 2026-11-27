/**
 * Mock gateway /v1/embeddings (OpenAI shape). Search, capture and memory ingest embed
 * text on the company's provider; in e2e that provider is the mock gateway, so it must
 * answer. Each input gets a deterministic 1536-dimension unit vector (the size
 * src/lib/server/llm/embedding.ts requires), derived from the text's SHA-256: the same
 * text always embeds the same, no network, no model.
 */
import { createHash } from 'node:crypto'

const DIMENSIONS = 1536

/** @param {string} text */
function vectorFor(text) {
  const out = new Array(DIMENSIONS)
  let block = Buffer.alloc(0)
  for (let i = 0; i < DIMENSIONS; i++) {
    if (i % 32 === 0)
      block = createHash('sha256')
        .update(`${i / 32}:${text}`)
        .digest()
    out[i] = block[i % 32] / 127.5 - 1
  }
  const norm = Math.sqrt(out.reduce((s, x) => s + x * x, 0))
  return out.map((x) => x / norm)
}

/**
 * @param {{ model?: string, input?: string | string[] }} body
 * @returns {{ status: number, body: any }}
 */
export function mockEmbeddings(body) {
  const inputs = typeof body?.input === 'string' ? [body.input] : body?.input
  if (!Array.isArray(inputs) || inputs.length === 0 || inputs.some((t) => typeof t !== 'string')) {
    return {
      status: 400,
      body: { error: { message: 'mock gateway: embeddings need input (a string or strings)' } },
    }
  }
  return {
    status: 200,
    body: {
      object: 'list',
      model: body.model,
      data: inputs.map((text, index) => ({
        object: 'embedding',
        index,
        embedding: vectorFor(text),
      })),
      usage: {
        prompt_tokens: inputs.reduce((n, t) => n + Math.ceil(t.length / 4), 0),
        total_tokens: 0,
      },
    },
  }
}
