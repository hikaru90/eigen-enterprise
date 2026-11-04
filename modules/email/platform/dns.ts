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
  purpose: 'dkim' | 'mail_from_mx' | 'spf' | 'dmarc'
  type: 'MX' | 'TXT'
  /** The full record name (FQDN). */
  name: string
  /** The name relative to the DNS zone — what most DNS providers' "Host" field wants. */
  host: string
  value: string
  priority: number | null
  status: DnsStatus
  /** DMARC is recommended, not required for sending. */
  required: boolean
}

export type DomainDnsState = {
  name: string
  region: string
  dkimSelector: string
  publicKey: string
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

/** The records the owner adds at their DNS provider, each with its own status. */
export function dnsRecords(d: DomainDnsState): DnsRecord[] {
  const mailFrom = mailFromDomain(d.name)
  const dkimName = `${d.dkimSelector}._domainkey.${d.name}`
  const dmarcName = `_dmarc.${registrableDomain(d.name)}`
  const mailFromStatus = asStatus(d.mailFromStatus)
  return [
    {
      purpose: 'dkim',
      type: 'TXT',
      name: dkimName,
      host: hostOf(dkimName, d.name),
      value: `p=${d.publicKey}`,
      priority: null,
      status: asStatus(d.dkimStatus),
      required: true,
    },
    {
      purpose: 'mail_from_mx',
      type: 'MX',
      name: mailFrom,
      host: hostOf(mailFrom, d.name),
      value: `feedback-smtp.${d.region}.amazonses.com`,
      priority: 10,
      status: mailFromStatus,
      required: true,
    },
    {
      purpose: 'spf',
      type: 'TXT',
      name: mailFrom,
      host: hostOf(mailFrom, d.name),
      value: 'v=spf1 include:amazonses.com ~all',
      priority: null,
      status: mailFromStatus,
      required: true,
    },
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
  ]
}
