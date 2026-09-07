/**
 * Chat-gateway env contract. The module cannot start without a bot token —
 * fail loud, no fallback (AGENTS.md guardrail).
 */
export function chatGatewayEnv(env: Record<string, string | undefined>): { botToken: string } {
  const raw = env.TELEGRAM_BOT_TOKEN
  if (raw === undefined || raw.trim().length === 0) {
    throw new Error(
      'chat-gateway: TELEGRAM_BOT_TOKEN is not set. The Telegram gateway cannot start without a bot token — set TELEGRAM_BOT_TOKEN in the environment (no fallback by design).',
    )
  }
  return { botToken: raw.trim() }
}
