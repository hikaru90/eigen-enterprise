import type { PageServerLoad } from './$types'
import { emailPlatform } from '../../../../../../modules/email/platform/service'
import { requireMember } from '../access.server'

/**
 * Email › API — "Send email from your app": the endpoint of THIS server, a
 * sender that can really send, and the sending keys (kept in the one key store, /api/keys).
 */
export const load: PageServerLoad = async ({ locals, url }) => {
  await requireMember(locals)
  const platform = emailPlatform()
  const configured = await platform.owlery.isConfigured()
  const senders = configured ? await platform.listSenders() : []
  return {
    endpoint: `${url.origin}/api/mail/send`,
    howtoUrl: `${url.origin}/docs/send-mail.md`,
    sender: senders.find((s) => s.isDefault)?.address ?? null,
    senders: senders.map((s) => s.address),
  }
}
