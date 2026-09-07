import { env } from '$lib/server/env/private-env'

/**
 * Whether Settings → LLM shows the BYOK provider configuration UI.
 * Explicit `BILLING_BYOK_UI_ENABLED` overrides; when unset, the UI is shown (self-host default).
 */
export function isByokUiEnabled(): boolean {
  const raw = env.BILLING_BYOK_UI_ENABLED?.trim().toLowerCase()
  if (raw === 'true') return true
  if (raw === 'false') return false
  return true
}
