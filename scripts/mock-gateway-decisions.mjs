/**
 * The decision model's endpoint on the mock gateway (scripts/mock-gateway.mjs):
 * OpenRouter's Decisions API (`POST /api/alpha/decisions`, served here at
 * `/alpha/decisions` next to the mock's `/v1`), kept pure so it is unit-tested
 * (mock-gateway-decisions.spec.ts). Lets specs, e2e and `evals/brain` run Jev
 * decisions offline (plan/phase-company-brain.md CB2).
 *
 * Request:  { model, state, questions: { [id]: { type: 'choice', instructions, criteria: { [choice]: criterion } } } }
 * Response: { model, answers: { [id]: { type: 'choice', choice, probabilities, confidence } },
 *             usage: { input_tokens, output_tokens, cost }, id, provider }
 *
 * Default: every question gets its first choice, certain (confidence 1).
 * Marker in the state: [mock-decide:<question id>=<choice>@<confidence>] answers
 * that question with that choice and confidence (the rest of the probability is
 * spread evenly over the other choices). The choice is not checked against the
 * closed set, so a spec can make the mock answer outside it.
 */

export const MOCK_DECISION_COST_USD = 0.000014

const MARKER = /\[mock-decide:([^=\]]+)=([^@\]]+)@([0-9.]+)\]/g

function markers(state) {
  const out = new Map()
  for (const m of state.matchAll(MARKER)) {
    const confidence = Number(m[3])
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      throw new Error(`mock-decide marker: confidence ${m[3]} is not between 0 and 1`)
    }
    out.set(m[1], { choice: m[2], confidence })
  }
  return out
}

const round = (n) => Math.round(n * 1e6) / 1e6

function answer(criteria, picked) {
  const keys = Object.keys(criteria)
  const choice = picked?.choice ?? keys[0]
  const confidence = picked?.confidence ?? 1
  const others = keys.filter((k) => k !== choice)
  const rest = others.length > 0 ? round((1 - confidence) / others.length) : 0
  const probabilities = Object.fromEntries(keys.map((k) => [k, k === choice ? confidence : rest]))
  return { type: 'choice', choice, probabilities, confidence }
}

/** @returns {{ status: number, body: any }} */
export function mockDecision(body) {
  const bad = (message) => ({ status: 400, body: { error: { message, code: 400 } } })
  if (!body || typeof body !== 'object') return bad('body is not an object')
  if (typeof body.model !== 'string' || !body.model) return bad('model is required')
  if (typeof body.state !== 'string') return bad('state is required')
  const questions = body.questions
  if (!questions || typeof questions !== 'object' || Object.keys(questions).length === 0) {
    return bad('questions must name at least one question')
  }
  for (const [id, q] of Object.entries(questions)) {
    if (!q || q.type !== 'choice') return bad(`question ${id}: Invalid discriminator value. Expected 'choice'`)
    if (!q.criteria || typeof q.criteria !== 'object' || Object.keys(q.criteria).length === 0) {
      return bad(`question ${id}: criteria must name at least one choice`)
    }
  }
  const picks = markers(body.state)
  const answers = Object.fromEntries(Object.entries(questions).map(([id, q]) => [id, answer(q.criteria, picks.get(id))]))
  return {
    status: 200,
    body: {
      model: `${body.model}-mock`,
      answers,
      usage: {
        input_tokens: Math.ceil(body.state.length / 4) + 50 * Object.keys(questions).length,
        output_tokens: 20 * Object.keys(questions).length,
        cost: MOCK_DECISION_COST_USD,
      },
      id: `gen-dec-mock-${Date.now()}`,
      provider: 'Mock',
    },
  }
}
