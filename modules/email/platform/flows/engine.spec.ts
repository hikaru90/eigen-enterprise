import { describe, expect, it } from 'vitest'
import { describeStep, flowSteps, nextAction, type FlowStep } from './engine'

const T = '00000000-0000-4000-8000-000000000001'
const steps: FlowStep[] = [
  { id: 's1', type: 'send', templateId: T },
  { id: 'w1', type: 'wait', amount: 2, unit: 'days' },
  { id: 's2', type: 'send', templateId: T, from: 'news@k.test' },
]
const now = new Date('2026-11-04T12:00:00Z')
const subscribed = { status: 'subscribed' }

describe('nextAction (flow engine steps)', () => {
  it('sends at the current send step', () => {
    expect(nextAction(steps, { stepIndex: 0, waitUntil: null }, subscribed, now)).toEqual({ type: 'send', step: steps[0] })
  })

  it('a wait first schedules itself, then waits, then is over', () => {
    const start = nextAction(steps, { stepIndex: 1, waitUntil: null }, subscribed, now)
    expect(start).toEqual({ type: 'start_wait', until: new Date('2026-11-06T12:00:00Z'), step: steps[1] })
    expect(nextAction(steps, { stepIndex: 1, waitUntil: new Date('2026-11-06T12:00:00Z') }, subscribed, now)).toEqual({
      type: 'still_waiting',
      until: new Date('2026-11-06T12:00:00Z'),
    })
    expect(nextAction(steps, { stepIndex: 1, waitUntil: new Date('2026-11-04T11:59:59Z') }, subscribed, now)).toEqual({
      type: 'wait_over',
      step: steps[1],
    })
  })

  it('completes after the last step; exits when the contact unsubscribed', () => {
    expect(nextAction(steps, { stepIndex: 3, waitUntil: null }, subscribed, now)).toEqual({ type: 'complete' })
    expect(nextAction(steps, { stepIndex: 0, waitUntil: null }, { status: 'unsubscribed' }, now)).toMatchObject({ type: 'exit' })
    expect(nextAction([], { stepIndex: 0, waitUntil: null }, subscribed, now)).toEqual({ type: 'complete' })
  })

  it('validates steps and describes them in words', () => {
    expect(flowSteps.safeParse(steps).success).toBe(true)
    expect(flowSteps.safeParse([{ id: 'x', type: 'wait', amount: 0, unit: 'days' }]).success).toBe(false)
    expect(flowSteps.safeParse([{ id: 'x', type: 'send', templateId: 'nope' }]).success).toBe(false)
    expect(describeStep(steps[1]!)).toBe('Wait 2 days')
    expect(describeStep({ id: 'w', type: 'wait', amount: 1, unit: 'hours' })).toBe('Wait 1 hour')
    expect(describeStep(steps[2]!, 'Welcome')).toBe('Send “Welcome” from news@k.test')
  })
})
