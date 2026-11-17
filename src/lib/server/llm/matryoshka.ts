/**
 * Matryoshka embedding models (owner, 2026-11-17: hosted companies embed with
 * qwen/qwen3-embedding-8b, 4096-dim natively). These models are trained so that
 * the first N values of a vector, scaled back to unit length, are themselves a
 * valid N-dim embedding. We always ask the gateway for `dimensions: 1536`; when a
 * gateway ignores that for such a model, the vectors are shortened here.
 *
 * Only models in this table are ever shortened. Any other model returning the
 * wrong length is left alone, so the 1536 check in embedding.ts fails loud.
 */
const MATRYOSHKA_MODELS: ReadonlySet<string> = new Set([
  'qwen/qwen3-embedding-0.6b',
  'qwen/qwen3-embedding-4b',
  'qwen/qwen3-embedding-8b',
  'openai/text-embedding-3-small',
  'openai/text-embedding-3-large',
])

export function isMatryoshkaModel(model: string): boolean {
  return MATRYOSHKA_MODELS.has(model)
}

function shorten(vector: number[], dimensions: number): number[] {
  const head = vector.slice(0, dimensions)
  const length = Math.sqrt(head.reduce((sum, x) => sum + x * x, 0))
  if (length === 0) throw new Error('embedding prefix is all zero; cannot shorten it to unit length')
  return head.map((x) => x / length)
}

type EmbeddingItem = { embedding?: unknown }

/**
 * The gateway's embeddings response with every vector longer than `dimensions`
 * shortened, when `model` is Matryoshka-trained. Returns the same object when
 * nothing needs shortening; validation of the shape stays in embedding.ts.
 */
export function fitEmbeddingResponse(model: string, body: unknown, dimensions: number): unknown {
  if (!isMatryoshkaModel(model) || !body || typeof body !== 'object') return body
  const data = (body as { data?: unknown }).data
  if (!Array.isArray(data)) return body
  const tooLong = (item: unknown) => {
    const e = (item as EmbeddingItem | null)?.embedding
    return Array.isArray(e) && e.length > dimensions && e.every((x) => typeof x === 'number')
  }
  if (!data.some(tooLong)) return body
  return {
    ...(body as object),
    data: data.map((item) =>
      tooLong(item) ? { ...(item as object), embedding: shorten((item as { embedding: number[] }).embedding, dimensions) } : item,
    ),
  }
}
