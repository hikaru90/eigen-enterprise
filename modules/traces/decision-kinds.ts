import { defineDecisionKind, type DecisionKindDef } from '$lib/server/decisions/kind'
import type { OpenField } from './enums'

/**
 * The traces decision kind (plan/traces-phone-home.md T1b, owner 2026-11-25): a value in a usage
 * trace that is not from a closed set we own (a company module's tool name, a custom model id) —
 * is it usage metadata about the product, or does it carry the company's or a person's content?
 * A closed set, so Jev; the box asks it before any such value could leave, once per distinct
 * value (the verdict is cached). `personal_or_content` is sent as the enum value `other`.
 *
 * Enforced from the start: there is no current judge, and nothing is acted on but the export,
 * whose failure mode is "not sent". The log keeps the field and the value (local to the box:
 * it is the company's own trace).
 */

export type TraceValueInput = { field: OpenField; value: string }
export type TraceValueChoice = 'usage_meta' | 'personal_or_content'
export const TRACE_VALUE_CHOICES = ['usage_meta', 'personal_or_content'] as const satisfies readonly TraceValueChoice[]

const FIELD_WORDS: Record<OpenField, string> = {
  tool: 'the name of a tool (an action of a software module) that was called',
  model: 'the id of the AI model a call was routed to',
}

export const TRACE_VALUE_DEF: DecisionKindDef<TraceValueInput, TraceValueChoice> = {
  id: 'traces.trace_value',
  module: 'traces',
  title: 'Is this trace value usage metadata or company content?',
  instructions:
    'A company’s eigenEnterprise box wants to tell the makers of the product how the product behaved, without telling them anything about the company. The value below is from such a usage trace. Is it plain usage metadata about the software (a technical name), or does it name or reveal the company, a person, a customer, a project or any of their content?',
  choices: TRACE_VALUE_CHOICES,
  criteria: {
    usage_meta:
      'The value is a generic technical identifier — a software action or model name such as "crm.sync_deals" or "openai/gpt-4o" — that names no company, person, customer, place, project or private matter.',
    personal_or_content:
      'The value contains or hints at a company, brand, person, customer, email, address, project, internal code name, or any text a person wrote, or it cannot be told apart from such.',
  },
  status: 'enforced',
  lowConfidence: 0,
  state: (i) => [`Field: ${FIELD_WORDS[i.field]}`, `Value: ${i.value}`].join('\n'),
  logInput: (i) => ({ field: i.field, value: i.value }),
}

export const tracesTraceValue = defineDecisionKind(TRACE_VALUE_DEF)
