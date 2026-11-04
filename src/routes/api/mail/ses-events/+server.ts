import type { RequestHandler } from './$types'
import { json } from '@sveltejs/kit'
import { emailPlatform } from '../../../../../modules/email/platform/service'
import { cachedCertFetcher, SnsSignatureError, verifySnsMessage } from '../../../../../modules/email/platform/sns-signature'

/**
 * POST /api/mail/ses-events — Amazon SNS delivers the SES delivery events of
 * the company's configuration sets here (plain text JSON, no Origin, no
 * session: exempt from the cross-site form check in $lib/server/csrf).
 * Nothing is read before the SNS signature verifies; then only our own topic
 * is accepted (EmailPlatform.handleSnsMessage).
 */
const fetchCert = cachedCertFetcher()

/** Overridable in tests. */
export const _deps = { platform: emailPlatform, fetchCert }

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
  const out = await _deps.platform().handleSnsMessage(message)
  return json(out.body, { status: out.status })
}
