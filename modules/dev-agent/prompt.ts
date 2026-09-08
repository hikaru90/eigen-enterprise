/**
 * The pi prompt contract: the dispatched task text verbatim, followed by the
 * MANDATORY engineering contract carried from AGENTS.md. Pure function — the
 * template is data, testable without spawning anything.
 */

export const PI_GUARDRAILS = [
  'MANDATORY ENGINEERING CONTRACT (binding; AGENTS.md is law for this repo):',
  '- Make every test pass: run `npx vitest run` for every scope you touched (at minimum `npx vitest run src/cli src/lib/kernel src/lib/server/mcp modules`).',
  '- Run `npm run check` before finishing: it must not add errors beyond the 5 known baseline errors (web-push/vapid x3, posthog x2).',
  '- Land your work as a single commit with an imperative commit message.',
  '- Never commit or log secrets; never print raw credentials, keys, or tokens.',
  '- Never weaken tests or assertions to make a build green — fix root causes, never work around them.',
  '- No fallbacks, no silent degradation, no temporary shims: fail loud with explicit errors.',
].join('\n')

export function buildPiPrompt(task: string): string {
  return `${task}\n\n${PI_GUARDRAILS}`
}
