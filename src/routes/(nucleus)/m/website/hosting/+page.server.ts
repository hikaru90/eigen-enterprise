import type { PageServerLoad } from './$types'
import { loadWebsiteSettings } from '../settings/settings-data.server'
export type { HostingData, HostingDomainRow } from '../settings/settings-data.server'

// Preserve the hosting URL while settings is the canonical navigation destination.
export const load: PageServerLoad = loadWebsiteSettings
