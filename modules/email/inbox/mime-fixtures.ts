/**
 * Raw MIME mails as SES writes them to the inbound bucket (CRLF line endings),
 * for the ingest specs. Senders and recipients are example.com / sender.example.
 */

const crlf = (lines: string[]) => lines.join('\r\n')

/** The bytes of the PDF attachment in WITH_ATTACHMENT (decoded). */
export const PDF_BYTES = Buffer.from('%PDF-1.4\n% ee inbox fixture\n%%EOF\n')
/** The bytes of the inline logo in WITH_ATTACHMENT (decoded). */
export const LOGO_BYTES = Buffer.from('GIF89a-ee-logo')

export const PLAIN = crlf([
  'Return-Path: <mara@sender.example>',
  'From: Mara Voss <mara@sender.example>',
  'To: Ana Lind <ana.lind@example.com>',
  'Cc: Sam <sam@sender.example>, ben@example.com',
  'Subject: Quarterly numbers',
  'Date: Thu, 12 Nov 2026 08:59:00 +0000',
  'Message-ID: <q3-numbers@sender.example>',
  'MIME-Version: 1.0',
  'Content-Type: text/plain; charset=utf-8',
  'Content-Transfer-Encoding: 8bit',
  '',
  'Hi Ana,',
  '',
  '   here are the   numbers for Q3.',
  'Grüße, Mara',
  '',
])

export const ALTERNATIVE = crlf([
  'From: "Mara Voss" <mara@sender.example>',
  'To: info@example.com',
  'Subject: =?UTF-8?Q?Gr=C3=BC=C3=9Fe?=',
  'Date: Thu, 12 Nov 2026 09:00:00 +0000',
  'Message-ID: <alt-1@sender.example>',
  'MIME-Version: 1.0',
  'Content-Type: multipart/alternative; boundary="b1"',
  '',
  '--b1',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'Plain part.',
  '--b1',
  'Content-Type: text/html; charset=utf-8',
  '',
  '<p>Plain <b>part</b>.</p>',
  '--b1--',
  '',
])

export const HTML_ONLY = crlf([
  'From: news@sender.example',
  'To: ana.lind@example.com',
  'Subject: Newsletter',
  'Date: Thu, 12 Nov 2026 09:01:00 +0000',
  'Message-ID: <news-1@sender.example>',
  'MIME-Version: 1.0',
  'Content-Type: text/html; charset=utf-8',
  '',
  '<html><body><h1>Welcome</h1><p>This is   the <i>November</i> issue.</p></body></html>',
  '',
])

export const WITH_ATTACHMENT = crlf([
  'From: Mara Voss <mara@sender.example>',
  'To: ana.lind@example.com',
  'Subject: Contract',
  'Date: Thu, 12 Nov 2026 09:02:00 +0000',
  'Message-ID: <contract-1@sender.example>',
  'MIME-Version: 1.0',
  'Content-Type: multipart/mixed; boundary="mix"',
  '',
  '--mix',
  'Content-Type: multipart/related; boundary="rel"',
  '',
  '--rel',
  'Content-Type: text/html; charset=utf-8',
  '',
  '<p>See the contract. <img src="cid:logo@sender.example"></p>',
  '--rel',
  'Content-Type: image/gif',
  'Content-Transfer-Encoding: base64',
  'Content-ID: <logo@sender.example>',
  'Content-Disposition: inline; filename="logo.gif"',
  '',
  LOGO_BYTES.toString('base64'),
  '--rel--',
  '--mix',
  'Content-Type: application/pdf; name="contract.pdf"',
  'Content-Transfer-Encoding: base64',
  'Content-Disposition: attachment; filename="contract.pdf"',
  '',
  PDF_BYTES.toString('base64'),
  '--mix--',
  '',
])

/** Ana's answer chain: replies to PLAIN (In-Reply-To) with the full References chain. */
export const REPLY = crlf([
  'From: Mara Voss <mara@sender.example>',
  'To: ana.lind@example.com',
  'Subject: Re: Quarterly numbers',
  'Date: Thu, 12 Nov 2026 10:00:00 +0000',
  'Message-ID: <q3-reply@sender.example>',
  'In-Reply-To: <q3-ana-answer@example.com>',
  'References: <q3-numbers@sender.example> <q3-ana-answer@example.com>',
  'MIME-Version: 1.0',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'Thanks!',
  '',
])

/** No From header at all: the envelope sender (MAIL FROM) is all there is. */
export const NO_FROM = crlf([
  'To: ana.lind@example.com',
  'Subject: Robot',
  'Message-ID: <robot@sender.example>',
  'Content-Type: text/plain',
  '',
  'beep',
  '',
])
