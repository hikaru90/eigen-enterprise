import { createAuthClient } from 'better-auth/svelte'
import { passkeyClient } from '@better-auth/passkey/client'

/** Browser client for Better Auth (OAuth redirects, session stores). Same-origin; no baseURL required. */
export const authClient = createAuthClient({
  plugins: [passkeyClient()],
})
