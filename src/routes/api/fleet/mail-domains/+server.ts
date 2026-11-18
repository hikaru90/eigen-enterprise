import type { RequestHandler } from './$types'
import { env } from '$env/dynamic/private'
import { mailDomainsHandler } from '$lib/server/fleet/mail-domains'
import { defaultEmailStore } from '../../../../../modules/email/platform/store'

/** Loopback only in practice: ee calls it on OS_INTERNAL_PORT with the per-box token (managed mode). */
export const GET: RequestHandler = ({ request }) =>
  mailDomainsHandler({
    token: env.EE_FLEET_LOCAL_TOKEN,
    list: async () => (await defaultEmailStore().listDomains()).map((d) => ({ name: d.name, receive: d.receiving })),
  })(request)
