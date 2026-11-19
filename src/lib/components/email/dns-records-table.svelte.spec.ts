import { describe, expect, it } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page } from 'vitest/browser'
import type { DnsRecord } from '../../../../modules/email/platform/dns'
import DnsRecordsTable from './dns-records-table.svelte'

const cname: DnsRecord = {
  purpose: 'dkim', type: 'CNAME', name: 'abc._domainkey.acme.test', host: 'abc._domainkey',
  value: 'abc.dkim.amazonses.com', priority: null, status: 'PENDING', required: true,
}
const dmarc: DnsRecord = {
  purpose: 'dmarc', type: 'TXT', name: '_dmarc.acme.test', host: '_dmarc',
  value: 'v=DMARC1; p=none;', priority: null, status: 'NOT_STARTED', required: false,
}

describe('dns-records-table', () => {
  it('with CNAME records: says they must not be proxied (Cloudflare: DNS only)', async () => {
    render(DnsRecordsTable, { domain: 'acme.test', records: [cname, dmarc] })
    await expect.element(page.getByTestId('dns-cname-hint')).toHaveTextContent(/DNS only/)
  })

  it('the DMARC row says to keep a single record (add this one only if there is none)', async () => {
    render(DnsRecordsTable, { domain: 'acme.test', records: [dmarc] })
    await expect.element(page.getByTestId('dns-record-dmarc')).toHaveTextContent(/only one DMARC record/)
    await expect.element(page.getByTestId('dns-cname-hint')).not.toBeInTheDocument()
  })
})
