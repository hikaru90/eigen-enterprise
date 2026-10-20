/**
 * Assisted onboarding: once the scripted first run ends (admin account, email,
 * AI provider), the orchestrator agent takes over in the chat. The handoff is
 * agent-driven, not more scripted UI: every orchestrator turn while assisted
 * onboarding is active carries this context block (prepended to the user input
 * by JourneyAwareAgentRuntime — engine-agnostic
 * see the same thing). The agent opens the website founding journey by
 * emitting an exact protocol marker; the runtime only parses that token.
 */

export type OnboardingFacts = {
  /** The scripted first run (welcome boot sequence) is finished or skipped. */
  welcomeCompleted: boolean
  adminAccount: boolean
  /** Company email delivery is configured. */
  email: boolean
  /** The conversing user has an AI provider connected. */
  aiProvider: boolean
  /** The website founding journey: never opened / running / completed. */
  website: 'not_started' | 'in_progress' | 'done'
}

/** Resolves the onboarding facts for the conversing human; null = not a human chat. */
export type OnboardingFactsResolver = (llmUserId: string | undefined) => Promise<OnboardingFacts | null>

/** The exact token the agent appends when the user agreed to start the website. */
export const ONBOARDING_START_WEBSITE_MARKER = '[[onboarding:website:start]]'

/** The agent takes over after the scripted setup, until the website journey starts. */
export function assistedOnboardingActive(facts: OnboardingFacts): boolean {
  return facts.welcomeCompleted && facts.website === 'not_started'
}

const doneOr = (done: boolean, missing: string): string => (done ? 'done' : missing)

/**
 * The onboarding context block. `firstWebsiteQuestion` is the website
 * journey's first step prompt fragment, so the agent asks it in the same reply
 * that starts the journey (the journey then drives itself).
 */
export function onboardingContextBlock(facts: OnboardingFacts, firstWebsiteQuestion: string): string {
  return [
    '[company onboarding context]',
    'The scripted setup is over; you now guide the owner in this chat (assisted onboarding).',
    'Done so far:',
    `- admin account: ${doneOr(facts.adminAccount, 'missing')}`,
    `- company email: ${doneOr(facts.email, 'not set up (offer it later, from settings)')}`,
    `- AI provider: ${doneOr(facts.aiProvider, 'missing')}`,
    'Next, in order:',
    '1. The company website (the website founding journey: name, what the company does, tone → pages + brand doc).',
    '2. Then the other modules, one at a time, offered by you: brand, memory, email, recap.',
    'Protocol:',
    '- Keep replies short and warm; one question per reply.',
    `- When the owner agrees to start the website, append exactly ${ONBOARDING_START_WEBSITE_MARKER} as the final line of your reply, and in that same reply do this: ${firstWebsiteQuestion}`,
    '- If the owner wants something else first, help with that; the website offer stays open. Never show or mention markers.',
    '[/company onboarding context]',
  ].join('\n')
}

/**
 * The hidden trigger for the agent's FIRST turn after the scripted setup.
 * The owner's words set the spirit; the agent phrases it.
 */
export const ONBOARDING_HANDOFF_INSTRUCTION = [
  '(The owner just finished the scripted setup and is now looking at the chat. This is not their message — open the conversation.)',
  'Open with ONE short, warm message ending in one question, in this spirit:',
  '"You did it — your company is set up and you’re its admin. What should we build first? I’d suggest your website, and we take it from there."',
  'Do not start the website yet: wait for the owner’s answer.',
].join('\n')

export function replyStartsWebsite(reply: string): boolean {
  return reply.includes(ONBOARDING_START_WEBSITE_MARKER)
}

export function stripOnboardingMarkers(reply: string): string {
  return reply.split(ONBOARDING_START_WEBSITE_MARKER).join('').trimEnd()
}

/** Website progress from the latest website-founding journey row's status (null = never opened). */
export function websiteStatusFrom(
  latest: 'active' | 'completed' | 'abandoned' | null,
): OnboardingFacts['website'] {
  if (latest === 'active') return 'in_progress'
  if (latest === 'completed') return 'done'
  // Never opened, or abandoned (stale spec): the website is still to do.
  return 'not_started'
}
