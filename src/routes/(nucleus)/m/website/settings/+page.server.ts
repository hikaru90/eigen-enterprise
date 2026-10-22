import type { PageServerLoad } from './$types'
import { loadWebsiteSettings } from './settings-data.server'

export const load: PageServerLoad = loadWebsiteSettings
