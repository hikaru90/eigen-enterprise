import { z } from 'zod'

/**
 * The flow engine (ported from Owlery's flow-engine, as a vertical step list
 * instead of a node graph): a flow is a trigger (a contact joins a list) and
 * an ordered list of steps — wait, send a template. Each contact's run is an
 * enrollment that remembers its step and, while waiting, until when.
 * `nextAction` is pure: the runner applies its answer and asks again.
 */

export const WAIT_UNITS = ['minutes', 'hours', 'days'] as const

export const flowStep = z.discriminatedUnion('type', [
  z.object({
    id: z.string().min(1),
    type: z.literal('wait'),
    amount: z.number().int().min(1).max(365),
    unit: z.enum(WAIT_UNITS),
  }),
  z.object({
    id: z.string().min(1),
    type: z.literal('send'),
    templateId: z.uuid(),
    /** One of the senders; the default sender when omitted. */
    from: z.email().optional(),
  }),
])

export type FlowStep = z.infer<typeof flowStep>
export const flowSteps = z.array(flowStep).max(50)

export type EnrollmentState = { stepIndex: number; waitUntil: Date | null }

export type FlowAction =
  | { type: 'complete' }
  | { type: 'exit'; reason: string }
  | { type: 'start_wait'; until: Date; step: FlowStep }
  | { type: 'still_waiting'; until: Date }
  | { type: 'wait_over'; step: FlowStep }
  | { type: 'send'; step: Extract<FlowStep, { type: 'send' }> }

const UNIT_MS: Record<(typeof WAIT_UNITS)[number], number> = { minutes: 60_000, hours: 3_600_000, days: 86_400_000 }

export function waitMs(step: Extract<FlowStep, { type: 'wait' }>): number {
  return step.amount * UNIT_MS[step.unit]
}

/**
 * What the enrollment does next. A contact who is no longer subscribed leaves
 * the flow; a wait first schedules itself, then advances once its time has
 * come; a send step sends and advances (the runner moves stepIndex on).
 */
export function nextAction(
  steps: FlowStep[],
  enrollment: EnrollmentState,
  contact: { status: string },
  now: Date,
): FlowAction {
  if (contact.status !== 'subscribed') return { type: 'exit', reason: 'The contact is no longer subscribed.' }
  const step = steps[enrollment.stepIndex]
  if (!step) return { type: 'complete' }
  if (step.type === 'wait') {
    if (!enrollment.waitUntil) return { type: 'start_wait', until: new Date(now.getTime() + waitMs(step)), step }
    if (enrollment.waitUntil.getTime() > now.getTime()) return { type: 'still_waiting', until: enrollment.waitUntil }
    return { type: 'wait_over', step }
  }
  return { type: 'send', step }
}

/** Plain words for a step (editor list, log). */
export function describeStep(step: FlowStep, templateName?: string): string {
  if (step.type === 'wait') return `Wait ${step.amount} ${step.amount === 1 ? step.unit.slice(0, -1) : step.unit}`
  return `Send “${templateName ?? 'a template'}”${step.from ? ` from ${step.from}` : ''}`
}
