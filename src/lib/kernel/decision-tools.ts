import type { ToolContext, ToolDescriptor } from './types'
import { z } from 'zod'
import { KernelError } from './errors'

/**
 * The decision plane's registry surface (plan/phase-company-brain.md §5, CB2): the declared
 * decision kinds with their status and agreement (decisions.kinds), the decision log
 * (decisions.log), a person's open "Needs you" questions (decisions.questions) and their answer
 * (decisions.answer). The dashboard's question rows are a client of these; the CLI, MCP and
 * the brain reach the same tools.
 *
 * Who reads what (logged decision): every member reads the kinds and their counts (aggregates,
 * no inputs). The log's rows — what was decided about what — owner and admins read in full
 * (they review the log before a kind's status changes); anyone else reads the rows about them,
 * made for them, or asked of them. A row holds the kind's own log view of the input and
 * choices from a closed set: an observation of what the model answered, never a judgment
 * written about a person.
 */

export const KERNEL_DECISION_TOOL_NAMES = ['decisions.kinds', 'decisions.log', 'decisions.questions', 'decisions.answer'] as const

export const KERNEL_DECISIONS_MODULE_ID = 'kernel'

const statusSchema = z.enum(['shadow', 'enforced'])

export const decisionKindViewSchema = z.object({
  id: z.string(),
  module: z.string(),
  title: z.string(),
  /** false: rows of a kind no longer declared in code. */
  declared: z.boolean(),
  status: statusSchema.nullable(),
  choices: z.array(z.string()),
  lowConfidence: z.number().nullable(),
  total: z.number().int(),
  /** Rows where Jev and the current judge both answered, and how many matched. */
  judgeCompared: z.number().int(),
  judgeAgreed: z.number().int(),
  /** Rows a person labelled after Jev answered, and how many matched. */
  humanCompared: z.number().int(),
  humanAgreed: z.number().int(),
  /** Jev against the person's label where there is one, else the current judge's answer. */
  compared: z.number().int(),
  agreed: z.number().int(),
  /** agreed / compared; null while nothing was compared. */
  agreement: z.number().nullable(),
  jevErrors: z.number().int(),
  openQuestions: z.number().int(),
  costUsd: z.number(),
})
export type DecisionKindView = z.infer<typeof decisionKindViewSchema>

export const decisionLogEntrySchema = z.object({
  id: z.string(),
  kind: z.string(),
  status: statusSchema,
  outcome: z.enum(['decided', 'pending', 'observed', 'failed']),
  input: z.record(z.string(), z.unknown()),
  jevChoice: z.string().nullable(),
  jevConfidence: z.number().nullable(),
  jevDistribution: z.record(z.string(), z.number()).nullable(),
  jevError: z.string().nullable(),
  model: z.string().nullable(),
  costUsd: z.number().nullable(),
  judgeChoice: z.string().nullable(),
  usedChoice: z.string().nullable(),
  usedSource: z.enum(['jev', 'current_judge', 'human']).nullable(),
  subjectUserId: z.string().nullable(),
  requestedBy: z.string(),
  askUserId: z.string().nullable(),
  question: z.string().nullable(),
  humanChoice: z.string().nullable(),
  labelledBy: z.string().nullable(),
  labelledAt: z.string().nullable(),
  createdAt: z.string(),
})
export type DecisionLogEntry = z.infer<typeof decisionLogEntrySchema>

export const decisionQuestionSchema = z.object({
  id: z.string(),
  kind: z.string(),
  title: z.string(),
  question: z.string(),
  choices: z.array(z.object({ choice: z.string(), label: z.string() })),
  askedAt: z.string(),
})
export type DecisionQuestionView = z.infer<typeof decisionQuestionSchema>

export type DecisionsPort = {
  kinds(): Promise<DecisionKindView[]>
  /** readerId null = every row (owner, admins). */
  log(input: { kind?: string; limit: number; readerId: string | null }): Promise<DecisionLogEntry[]>
  questions(userId: string): Promise<DecisionQuestionView[]>
  /** Throws KernelError invalid_input when the question is not the person's open one, or the choice is not in its set. */
  answer(userId: string, decisionId: string, choice: string): Promise<{ decisionId: string; kind: string; choice: string }>
}

const logInput = z
  .object({
    /** Only this kind's decisions (a kind id from decisions.kinds). */
    kind: z.string().min(1).optional(),
    limit: z.number().int().min(1).max(200).default(50),
  })
  .strict()

const answerInput = z
  .object({
    /** The question's id (decisions.questions). */
    decision_id: z.string().uuid(),
    /** One of the question's choices. */
    choice: z.string().min(1),
  })
  .strict()

const READ_ROLES = ['member']

const readsEveryRow = (ctx: ToolContext) => ctx.principal.roles.includes('admin') || ctx.principal.roles.includes('owner')

/** A question asked of a person is answered by that person (themselves, or the brain acting for them) — never an agent or a co-worker. */
function personOf(ctx: ToolContext): string {
  if (ctx.principal.kind !== 'human') {
    throw new KernelError('no_person', 'A decision question is answered by the person it was asked of; this call names no person.')
  }
  return ctx.principal.id
}

export function createDecisionTools(deps: { port: DecisionsPort }): ToolDescriptor[] {
  return [
    {
      name: 'decisions.kinds',
      module: KERNEL_DECISIONS_MODULE_ID,
      summary:
        'The decision kinds (closed-set questions Jev answers, plan CB2): per kind its status (shadow: Jev runs next to the current judge and the judge’s answer is used; enforced: Jev’s answer is used), choices, low-confidence threshold and, from the decision log, how often Jev matched the current judge and people’s answers (agreement), errors, open questions and cost. A status changes only in code, after this was reviewed.',
      auditClass: 'read',
      inputSchema: z.object({}).strict(),
      outputSchema: z.object({ kinds: z.array(decisionKindViewSchema) }),
      permission: { roles: READ_ROLES },
      handler: async () => ({ kinds: await deps.port.kinds() }),
    },
    {
      name: 'decisions.log',
      module: KERNEL_DECISIONS_MODULE_ID,
      summary:
        'Recent decisions from the decision log, newest first ({kind?: a kind id, limit?: 1–200, default 50}): what Jev chose with its confidence, the current judge’s answer, what was used, and a person’s answer to a question. Owner and admins read every row; anyone else the rows about them, made for them or asked of them.',
      auditClass: 'read',
      inputSchema: logInput,
      outputSchema: z.object({ decisions: z.array(decisionLogEntrySchema) }),
      permission: { roles: READ_ROLES },
      handler: async (ctx, input) => {
        const { kind, limit } = logInput.parse(input ?? {})
        return {
          decisions: await deps.port.log({ ...(kind ? { kind } : {}), limit, readerId: readsEveryRow(ctx) ? null : ctx.principal.id }),
        }
      },
    },
    {
      name: 'decisions.questions',
      module: KERNEL_DECISIONS_MODULE_ID,
      summary:
        'Your open decision questions ("Needs you"): where Jev was unsure, a person answers from the closed set instead of a guess. Each with its id, the question, and the choices with their labels. Answer with decisions.answer.',
      auditClass: 'read',
      inputSchema: z.object({}).strict(),
      outputSchema: z.object({ questions: z.array(decisionQuestionSchema) }),
      permission: { roles: READ_ROLES },
      handler: async (ctx) => ({ questions: await deps.port.questions(ctx.principal.id) }),
    },
    {
      name: 'decisions.answer',
      module: KERNEL_DECISIONS_MODULE_ID,
      summary:
        'Answer one of your open decision questions: {decision_id: from decisions.questions, choice: one of its choices}. Your answer is used for that decision and logged as the human label Jev is measured against. Only the person asked answers.',
      auditClass: 'mutate',
      activity: (_input: unknown, output?: { kind: string; choice: string }) =>
        output ? `Answered a decision question (${output.kind}: ${output.choice})` : 'Answered a decision question',
      inputSchema: answerInput,
      outputSchema: z.object({ decisionId: z.string(), kind: z.string(), choice: z.string() }),
      permission: { roles: READ_ROLES },
      handler: async (ctx, input) => {
        const { decision_id, choice } = answerInput.parse(input)
        return deps.port.answer(personOf(ctx), decision_id, choice)
      },
    },
  ]
}
