import type { RequestHandler } from './$types'
import { json } from '@sveltejs/kit'
import { dev } from '$app/environment'

/**
 * Dev/e2e only: run one Contribute sharing pass now — the same pass the
 * global job-queue tick runs every minute (scrub, sign, send to
 * CONTRIBUTE_HUB_URL) — so the phone-home journey does not wait for the
 * ticker. Passes run one at a time in the process (live.ts), so this never
 * races the ticker.
 *
 *   POST → { result } the pass's ShareTickResult (null on a hub install)
 */
export const POST: RequestHandler = async () => {
  if (!dev) return json({ error: 'Contribute sharing harness API only available in dev mode' }, { status: 403 })
  const { shareTick } = await import('../../../../../../modules/contribute/share/live')
  return json({ result: await shareTick() })
}
