import type { CompanyMail } from './company-mail'
import { owleryService } from '../../../../modules/email/owlery/service'

export {
  MailNotConfiguredError,
  MailSetupError,
  SenderNotVerifiedError,
  type CompanyMail,
  type SaveMailSettingsInput,
  type SendMailInput,
} from './company-mail'

/**
 * The process-wide company mail. Backed by the Owlery email module, which owns
 * the SES credentials and all sending; callers only see this contract.
 */
export function companyMail(): CompanyMail {
  return owleryService()
}
