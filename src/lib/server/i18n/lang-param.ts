import type { Cookies } from '@sveltejs/kit'
import { error, redirect } from '@sveltejs/kit'
import { cookieMaxAge, cookieName, locales, type Locale } from '$lib/paraglide/runtime'

/**
 * `?lang=en|de` on an entry page (/login, /signup): the marketing website links
 * the demo company in the language the visitor reads it in (wish fd96580a).
 * Sets the UI language cookie and reloads the page without the parameter, so
 * the page renders in that language. A language the app doesn't have is
 * refused (400).
 */
export function applyLangParam(url: URL, cookies: Pick<Cookies, 'set'>): void {
  const lang = url.searchParams.get('lang')
  if (lang === null) return
  if (!(locales as readonly string[]).includes(lang)) {
    error(400, `The app has no language “${lang}” (it has ${locales.join(', ')}).`)
  }
  cookies.set(cookieName, lang as Locale, { path: '/', maxAge: cookieMaxAge, httpOnly: false, sameSite: 'lax' })
  const rest = new URLSearchParams(url.searchParams)
  rest.delete('lang')
  const query = rest.toString()
  redirect(303, `${url.pathname}${query ? `?${query}` : ''}`)
}
