/**
 * Owner-facing one-line blurbs for the module cards and pages (C3b). The
 * manifests' own `description` is written for the agent and for developers
 * ("kernel", "hybrid retrieval", "GTD"); the owner reads these instead. A
 * module without an entry shows its manifest description.
 */
const BLURBS: Record<string, string> = {
  website:
    'Your apps and company site: connect code from GitHub, publish it and manage its addresses.',
  email: "Your company's email: the address you send from and the mail the agent sends for you.",
  brand: 'How your company looks and sounds: the chosen style and everything it shapes.',
  memory: 'Tasks, projects and notes you and the agent keep, and a place to capture a thought.',
  members: 'The people in your company, their roles and invites.',
  recap: 'A short daily summary of what happened, sent to you.',
  'chat-gateway': 'Talk to the agent from your messaging apps.',
}

export function ownerModuleBlurb(moduleId: string, fallback: string): string {
  return BLURBS[moduleId] ?? fallback
}
