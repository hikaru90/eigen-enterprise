import { describe, expect, it } from 'vitest'
import { htmlToReadable } from './readable'

describe('htmlToReadable', () => {
  it('keeps title, headings, list items and absolute links; drops scripts and styles', () => {
    const html = `<html><head><title>Kindred &amp; Co</title><style>p{}</style></head><body>
      <script>alert(1)</script><!-- hidden -->
      <h1>Welcome</h1><p>We build&nbsp;sites.</p>
      <ul><li>One</li><li>Two</li></ul>
      <a href="/about">About us</a> <img src="x.png" alt="Logo">
    </body></html>`
    const out = htmlToReadable(html, 'https://kindred.example/home')
    expect(out.title).toBe('Kindred & Co')
    expect(out.text).toContain('# Welcome')
    expect(out.text).toContain('We build sites.')
    expect(out.text).toContain('- One\n- Two')
    expect(out.text).toContain('About us (https://kindred.example/about)')
    expect(out.text).toContain('[image: Logo]')
    expect(out.text).not.toContain('alert')
    expect(out.text).not.toContain('hidden')
  })
})
