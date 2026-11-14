import { generateKeyPairSync } from 'node:crypto'
import { getDomain } from 'tldts'

/**
 * Sender-domain DNS (ported from Owlery's domain-service): our own DKIM key
 * (BYO-DKIM — the private half goes to Amazon, the public half into DNS), a
 * MAIL FROM subdomain with its MX + SPF, and a recommended DMARC record.
 */

export const DKIM_SELECTOR = 'ee'

/** SES verification states, also used per DNS record. */
export type DnsStatus = 'NOT_STARTED' | 'PENDING' | 'SUCCESS' | 'FAILED' | 'TEMPORARY_FAILURE'

export type DnsRecord = {
  /** What the record is for, in plain words. */
  purpose: 'dkim' | 'mail_from_mx' | 'spf' | 'dmarc' | 'inbound_mx'
  type: 'MX' | 'TXT' | 'CNAME'
  /** The full record name (FQDN). */
  name: string
  /** The name relative to the DNS zone — what most DNS providers' "Host" field wants. */
  host: string
  /** Null only for a DKIM key the owner published outside ee (Amazon never shows its public half). */
  value: string | null
  priority: number | null
  status: DnsStatus
  /** DMARC is recommended, not required for sending. */
  required: boolean
}

export type DomainDnsState = {
  name: string
  region: string
  dkimSelector: string
  /** Our BYO-DKIM public key; null for an adopted domain. */
  publicKey: string | null
  /** Easy DKIM tokens of an adopted domain (CNAMEs to Amazon); null otherwise. */
  dkimTokens: string[] | null
  /** The MAIL FROM subdomain; null = Amazon's own MAIL FROM (no records to publish). */
  mailFromDomain: string | null
  dkimStatus: string
  mailFromStatus: string
  dmarcAdded: boolean
}

export class InvalidDomainError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidDomainError'
  }
}

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/

/**
 * A domain the owner typed, normalised (lowercase, no scheme/path/trailing dot)
 * — or a plain-language error. It must sit under a public suffix (kindred.com,
 * news.kindred.co.uk), never be a bare suffix (co.uk) or an address.
 */
export function normalizeDomain(input: string): string {
  let d = input.trim().toLowerCase()
  if (d.includes('@')) throw new InvalidDomainError('Enter just the domain (like yourcompany.com), not an email address.')
  d = d.replace(/^[a-z]+:\/\//, '').replace(/\/.*$/, '').replace(/\.$/, '')
  if (!d) throw new InvalidDomainError('Enter a domain, like yourcompany.com.')
  if (d.length > 253 || !d.split('.').every((l) => LABEL.test(l))) {
    throw new InvalidDomainError(`"${input.trim()}" is not a domain name. It looks like yourcompany.com.`)
  }
  const registrable = getDomain(d)
  if (!registrable) throw new InvalidDomainError(`"${d}" is not a domain you can own. Use one like yourcompany.com.`)
  return d
}

/** The registrable domain (kindred.com for news.kindred.com) — where DMARC lives. */
export function registrableDomain(domain: string): string {
  const r = getDomain(domain)
  if (!r) throw new InvalidDomainError(`"${domain}" is not a domain you can own.`)
  return r
}

/** Name relative to the zone of the registrable domain ("" stands for the zone apex, shown as "@"). */
function hostOf(fqdn: string, domain: string): string {
  const zone = registrableDomain(domain)
  if (fqdn === zone) return '@'
  return fqdn.endsWith(`.${zone}`) ? fqdn.slice(0, -(zone.length + 1)) : fqdn
}

/** The MAIL FROM subdomain SES bounces through: mail.<domain>. */
export function mailFromDomain(domain: string): string {
  return `mail.${domain}`
}

/** 2048-bit RSA DKIM key pair as SES and DNS want them: base64 bodies, no PEM armour. */
export function generateDkimKeyPair(): { privateKey: string; publicKey: string } {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  })
  const body = (pem: string) => pem.replace(/-----(BEGIN|END) [A-Z ]+-----/g, '').replace(/\s+/g, '')
  return { privateKey: body(privateKey), publicKey: body(publicKey) }
}

function asStatus(raw: string): DnsStatus {
  const s = raw.toUpperCase()
  return s === 'PENDING' || s === 'SUCCESS' || s === 'FAILED' || s === 'TEMPORARY_FAILURE' ? s : 'NOT_STARTED'
}

/** Where SES receives mail for a domain in this region (the MX target when receiving is on). */
export function inboundMxHost(region: string): string {
  return `inbound-smtp.${region}.amazonaws.com`
}

export type MxRecord = { exchange: string; priority: number }

/** Whether the domain's MX records already point at SES receiving (exact host match). */
export function inboundMxSeen(mx: MxRecord[], region: string): boolean {
  const target = inboundMxHost(region)
  return mx.some((r) => r.exchange.trim().toLowerCase().replace(/\.$/, '') === target)
}

/**
 * The records the owner adds at their DNS provider, each with its own status.
 * `inboundMx` is the status of the receiving MX record, or null while the
 * domain does not receive mail (no record is shown then).
 */
export function dnsRecords(d: DomainDnsState, inboundMx: DnsStatus | null): DnsRecord[] {
  const dmarcName = `_dmarc.${registrableDomain(d.name)}`
  const mailFromStatus = asStatus(d.mailFromStatus)
  const dkimStatus = asStatus(d.dkimStatus)
  const dkim: DnsRecord[] = d.dkimTokens
    ? d.dkimTokens.map((token) => {
        const name = `${token}._domainkey.${d.name}`
        return {
          purpose: 'dkim' as const,
          type: 'CNAME' as const,
          name,
          host: hostOf(name, d.name),
          value: `${token}.dkim.amazonses.com`,
          priority: null,
          status: dkimStatus,
          required: true,
        }
      })
    : [
        {
          purpose: 'dkim',
          type: 'TXT',
          name: `${d.dkimSelector}._domainkey.${d.name}`,
          host: hostOf(`${d.dkimSelector}._domainkey.${d.name}`, d.name),
          value: d.publicKey === null ? null : `p=${d.publicKey}`,
          priority: null,
          status: dkimStatus,
          required: true,
        },
      ]
  const mailFrom: DnsRecord[] = d.mailFromDomain
    ? [
        {
          purpose: 'mail_from_mx',
          type: 'MX',
          name: d.mailFromDomain,
          host: hostOf(d.mailFromDomain, d.name),
          value: `feedback-smtp.${d.region}.amazonses.com`,
          priority: 10,
          status: mailFromStatus,
          required: true,
        },
        {
          purpose: 'spf',
          type: 'TXT',
          name: d.mailFromDomain,
          host: hostOf(d.mailFromDomain, d.name),
          value: 'v=spf1 include:amazonses.com ~all',
          priority: null,
          status: mailFromStatus,
          required: true,
        },
      ]
    : []
  return [
    ...dkim,
    ...mailFrom,
    {
      purpose: 'dmarc',
      type: 'TXT',
      name: dmarcName,
      host: hostOf(dmarcName, d.name),
      value: 'v=DMARC1; p=none;',
      priority: null,
      status: d.dmarcAdded ? 'SUCCESS' : 'NOT_STARTED',
      required: false,
    },
    ...(inboundMx === null
      ? []
      : [
          {
            purpose: 'inbound_mx' as const,
            type: 'MX' as const,
            name: d.name,
            host: hostOf(d.name, d.name),
            value: inboundMxHost(d.region),
            priority: 10,
            status: inboundMx,
            required: true,
          },
        ]),
  ]
}
