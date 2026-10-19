import { describe, expect, it } from 'vitest'
import {
  ONBOARDING_HANDOFF_INSTRUCTION,
  ONBOARDING_START_WEBSITE_MARKER,
  assistedOnboardingActive,
  onboardingContextBlock,
  replyStartsWebsite,
  stripOnboardingMarkers,
  websiteStatusFrom,
  type OnboardingFacts,
} from './onboarding-context'

const facts = (over: Partial<OnboardingFacts> = {}): OnboardingFacts => ({
  welcomeCompleted: true,
  adminAccount: true,
  email: true,
  aiProvider: true,
  website: 'not_started',
  ...over,
})

describe('assisted onboarding — when the agent takes over', () => {
  it('is active once the scripted setup ended and the website is not started', () => {
    expect(assistedOnboardingActive(facts())).toBe(true)
  })

  it('is inactive before the scripted setup ended (the wizard still owns the screen)', () => {
    expect(assistedOnboardingActive(facts({ welcomeCompleted: false }))).toBe(false)
  })

  it('is inactive once the website journey is running or done (the journey drives)', () => {
    expect(assistedOnboardingActive(facts({ website: 'in_progress' }))).toBe(false)
    expect(assistedOnboardingActive(facts({ website: 'done' }))).toBe(false)
  })
})

describe('onboarding context block', () => {
  it('states what is done: admin account, email, AI provider', () => {
    const block = onboardingContextBlock(facts(), 'Ask for the company name (one short answer).')
    expect(block).toContain('[company onboarding context]')
    expect(block).toContain('[/company onboarding context]')
    expect(block).toMatch(/admin account: done/)
    expect(block).toMatch(/company email: done/)
    expect(block).toMatch(/AI provider: done/)
  })

  it('names what is next: the website first, then the other modules', () => {
    const block = onboardingContextBlock(facts(), 'Ask for the company name (one short answer).')
    const websiteAt = block.indexOf('website')
    const modulesAt = block.indexOf('other modules')
    expect(websiteAt).toBeGreaterThan(-1)
    expect(modulesAt).toBeGreaterThan(websiteAt)
  })

  it('reports email honestly when it was skipped', () => {
    expect(onboardingContextBlock(facts({ email: false }), 'q')).toMatch(/company email: not set up/)
  })

  it('carries the start protocol: exact marker + the journey’s first question', () => {
    const block = onboardingContextBlock(facts(), 'Ask for the company name (one short answer).')
    expect(block).toContain(ONBOARDING_START_WEBSITE_MARKER)
    expect(block).toContain('Ask for the company name (one short answer).')
  })
})

describe('handoff opening turn', () => {
  it('asks the agent for ONE short, warm question proposing the website — in the owner’s spirit', () => {
    expect(ONBOARDING_HANDOFF_INSTRUCTION).toMatch(/one question/i)
    expect(ONBOARDING_HANDOFF_INSTRUCTION).toContain('You did it')
    expect(ONBOARDING_HANDOFF_INSTRUCTION).toMatch(/website/)
  })
})

describe('start marker protocol (exact token, no heuristics)', () => {
  it('detects only the exact marker', () => {
    expect(replyStartsWebsite(`Great — what’s your company called?\n${ONBOARDING_START_WEBSITE_MARKER}`)).toBe(true)
    expect(replyStartsWebsite('Sure, let us start with the website.')).toBe(false)
  })

  it('strips the marker from the user-facing reply', () => {
    expect(stripOnboardingMarkers(`Great.\n${ONBOARDING_START_WEBSITE_MARKER}`)).toBe('Great.')
  })
})

describe('websiteStatusFrom', () => {
  it('maps the latest journey status to website progress', () => {
    expect(websiteStatusFrom(null)).toBe('not_started')
    expect(websiteStatusFrom('abandoned')).toBe('not_started')
    expect(websiteStatusFrom('active')).toBe('in_progress')
    expect(websiteStatusFrom('completed')).toBe('done')
  })
})
