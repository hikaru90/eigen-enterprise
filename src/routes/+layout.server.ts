import type { LayoutServerLoad } from './$types'
import { eq } from 'drizzle-orm'
import { normalizeUiLocale } from '$lib/i18n/ui-locale'
import { cookieMaxAge, cookieName } from '$lib/paraglide/runtime'
import { isUserAdmin } from '$lib/server/auth/user-role'
import { getDb } from '$lib/server/db'
import { userPreference } from '$lib/server/db/schema'
import { listAuthorLayersForUser } from '$lib/server/memory/authorship'
import { defaultBrandStore } from '../../modules/brand/store'

export const load: LayoutServerLoad = async ({ locals, cookies }) => {
  let preferredUiLocale: string | null = null
  let preferredLanguage = 'en'
  let isAdmin = false
  let authorLayers: Awaited<ReturnType<typeof listAuthorLayersForUser>> = []

  if (locals.user) {
    isAdmin = await isUserAdmin(locals.user.id)
    authorLayers = await listAuthorLayersForUser(locals.user.id)
    const [pref] = await getDb()
      .select({
        preferredUiLocale: userPreference.preferredUiLocale,
        preferredLanguage: userPreference.preferredLanguage,
      })
      .from(userPreference)
      .where(eq(userPreference.userId, locals.user.id))
      .limit(1)

    preferredUiLocale = normalizeUiLocale(pref?.preferredUiLocale ?? 'en')
    preferredLanguage = pref?.preferredLanguage ?? 'en'
    const currentCookie = cookies.get(cookieName)
    if (currentCookie !== preferredUiLocale) {
      cookies.set(cookieName, preferredUiLocale, {
        path: '/',
        maxAge: cookieMaxAge,
        httpOnly: false,
        sameSite: 'lax',
      })
    }
  }

  // Phase-2d M5 (V9): the active visual set's tokens ride every response so
  // the root layout can emit the global :root override. Null = no active set
  // = the app keeps its own style (legit state, never a fallback); every
  // other store failure propagates loud.
  const activeVisualSet = await defaultBrandStore().findActiveVisualSet()

  return {
    user: locals.user ?? null,
    isAdmin,
    preferredUiLocale,
    preferredLanguage,
    authorLayers,
    activeVisualSet: activeVisualSet
      ? { cssVars: activeVisualSet.cssVars, darkCssVars: activeVisualSet.darkCssVars }
      : null,
  }
}
