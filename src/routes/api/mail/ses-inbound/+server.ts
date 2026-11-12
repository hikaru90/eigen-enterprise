import type { RequestHandler } from './$types'
import { json } from '@sveltejs/kit'
import { handleInboundSns } from '../../../../../modules/email/inbox/inbound'
import { inboundDeps } from '../../../../../modules/email/inbox/live'
import { cachedCertFetcher, SnsSignatureError, verifySnsMessage } from '../../../../../modules/email/platform/sns-signature'

/**
 * POST /api/mail/ses-inbound (INBOUND_CALLBACK_PATH) — Amazon SNS delivers the
 * company's SES receipt notifications here (S3 action + topic, plan/email-inbox.md).
 * Unauthenticated by design: plain text JSON, no Origin, no session (exempt from
 * the cross-site form check in $lib/server/csrf). The SNS signature is the
 * authentication; nothing is read before it verifies, then only the stored
 * receiving topic is accepted (modules/email/inbox/inbound.ts).
 */
const fetchCert = cachedCertFetcher()

/** Overridable in tests. */
export const _deps = { inbound: inboundDeps, fetchCert }

export const POST: RequestHandler = async ({ request }) => {
  let body: unknown
  try {
    body = JSON.parse(await request.text())
  } catch {
    return json({ error: 'The body must be an Amazon SNS message (JSON).' }, { status: 400 })
  }
  let message
  try {
    message = await verifySnsMessage(body, _deps.fetchCert)
  } catch (err) {
    if (err instanceof SnsSignatureError) return json({ error: err.message }, { status: 401 })
    throw err
  }
  const out = await handleInboundSns(await _deps.inbound(), message)
  return json(out.body, { status: out.status })
}
