import type { RequestHandler } from './$types'
import howto from '$lib/server/mail/send-mail-howto.md?raw'

/**
 * The how-to an app's coding agent reads to send mail (docs/agents/send-mail.md
 * is the curl version for people). Public on purpose: it holds no secret, and
 * the agent fetches it from wherever it runs. Static text, never templated, so
 * nothing user-controlled can reach an agent as an instruction. `noindex` keeps
 * it out of search results; it is not an access control.
 */
export const GET: RequestHandler = () =>
  new Response(howto, {
    headers: {
      'content-type': 'text/markdown; charset=utf-8',
      'x-robots-tag': 'noindex, nofollow',
      'cache-control': 'public, max-age=300',
    },
  })
