import { getUserRole } from '$lib/server/auth/user-role'
import { MailNotConfiguredError, MailSetupError } from '$lib/server/mail/company-mail'
import { managedSenderRoute } from '$lib/server/onboarding/managed-sender'
import { EmailPlatformError, emailPlatform } from '../../../../modules/email/platform/service'
import { domainsClient } from './client'
import { connectRoutes } from './connect-http'
import { domainsFromEnv } from './env'
import { domainsRoutes } from './http'

/** The domains routes over this process's EE_DOMAINS_* (the token stays on the server). */
export const liveDomainsRoutes = () => domainsRoutes({ role: getUserRole, config: domainsFromEnv })

/** "I already have one" over the email platform. */
export const liveConnectRoutes = () =>
  connectRoutes({
    role: getUserRole,
    platform: emailPlatform(),
    explained: (err): err is Error =>
      err instanceof EmailPlatformError || err instanceof MailSetupError || err instanceof MailNotConfiguredError,
  })

/** The managed Email act: the default sender on a company domain. */
export const liveManagedSender = () => {
  const platform = emailPlatform()
  const config = domainsFromEnv()
  return managedSenderRoute({
    role: getUserRole,
    mode: () => platform.owlery.mode(),
    mailDomains: async () => (await platform.listDomains()).map((d) => ({ name: d.name, sendable: d.sendable })),
    bought: config ? () => domainsClient(config).list() : null,
    setDefaultSender: (address, by) => platform.owlery.setDefaultSender(address, by),
  })
}
