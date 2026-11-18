import type { DnsRecord } from '../../../modules/email/platform/dns'

/**
 * A mail domain as the records view shows it (the Domain act's "I already
 * have one", Settings › Domains): what /api/domains/connected answers.
 */
export type ConnectedDomain = {
  id: string
  name: string
  status: string
  sendable: boolean
  isVerifying: boolean
  errorMessage: string | null
  adopted: boolean
  lastCheckedAt: string | null
  records: DnsRecord[]
}
