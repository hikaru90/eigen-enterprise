import { eq, sql } from 'drizzle-orm'
import type { CroppableLogoType, LogoType } from '$lib/company/identity'
import type { LogoCrop } from '$lib/company/logo-crop'
import { companyProfile } from '$lib/server/db/company.schema'
import { getDb, type AppDatabase } from '$lib/server/db/context'

/** The company's one profile row (migration 0125): the name set in Settings → Company and the logo. */

/** The uploaded image a cropped logo was cut from, and the crop (migration 0144). */
export type CompanyLogoOriginal = { sha256: string; mime: CroppableLogoType; crop: LogoCrop }

/** The logo as stored; `original` is there when it was cropped from a kept original. */
export type CompanyLogo = { sha256: string; mime: LogoType; original?: CompanyLogoOriginal }

export type CompanyProfile = {
  /** null = never set here (the founding interview's name applies). */
  name: string | null
  logo: CompanyLogo | null
  updatedBy: string
  updatedAt: Date
}

export type CompanyProfileStore = {
  get(): Promise<CompanyProfile | null>
  setName(name: string, by: string): Promise<void>
  /** Sets (or with null removes) the logo; hands back the one it replaced so its bytes can go. */
  setLogo(logo: CompanyLogo | null, by: string): Promise<{ previous: CompanyLogo | null }>
}

const ROW = 'company'

type LogoColumns = {
  logoSha256: string | null
  logoMime: LogoType | null
  logoOriginalSha256: string | null
  logoOriginalMime: CroppableLogoType | null
  logoCropLeft: number | null
  logoCropTop: number | null
  logoCropSize: number | null
}

const logoOf = (row: LogoColumns): CompanyLogo | null => {
  const { logoSha256: sha256, logoMime: mime } = row
  if (sha256 === null && mime === null) return null
  // The table's checks make these impossible; a half logo is corruption, said loud.
  if (sha256 === null || mime === null) throw new Error('company_profile holds half a logo (sha256 and mime must be set together)')
  const { logoOriginalSha256: oSha, logoOriginalMime: oMime, logoCropLeft: left, logoCropTop: top, logoCropSize: size } = row
  if (oSha === null && oMime === null && left === null && top === null && size === null) return { sha256, mime }
  if (oSha === null || oMime === null || left === null || top === null || size === null) {
    throw new Error('company_profile holds half a logo original (original sha256, mime and crop must be set together)')
  }
  return { sha256, mime, original: { sha256: oSha, mime: oMime, crop: { left, top, size } } }
}

const columnsOf = (logo: CompanyLogo | null): LogoColumns => ({
  logoSha256: logo?.sha256 ?? null,
  logoMime: logo?.mime ?? null,
  logoOriginalSha256: logo?.original?.sha256 ?? null,
  logoOriginalMime: logo?.original?.mime ?? null,
  logoCropLeft: logo?.original?.crop.left ?? null,
  logoCropTop: logo?.original?.crop.top ?? null,
  logoCropSize: logo?.original?.crop.size ?? null,
})

const LOGO_SELECT = {
  logoSha256: companyProfile.logoSha256,
  logoMime: companyProfile.logoMime,
  logoOriginalSha256: companyProfile.logoOriginalSha256,
  logoOriginalMime: companyProfile.logoOriginalMime,
  logoCropLeft: companyProfile.logoCropLeft,
  logoCropTop: companyProfile.logoCropTop,
  logoCropSize: companyProfile.logoCropSize,
}

export function dbCompanyProfileStore(db: AppDatabase): CompanyProfileStore {
  return {
    async get() {
      const [row] = await db.select().from(companyProfile).where(eq(companyProfile.id, ROW)).limit(1)
      if (!row) return null
      return { name: row.name, logo: logoOf(row), updatedBy: row.updatedBy, updatedAt: row.updatedAt }
    },
    async setName(name, by) {
      await db
        .insert(companyProfile)
        .values({ id: ROW, name, updatedBy: by })
        .onConflictDoUpdate({ target: companyProfile.id, set: { name, updatedBy: by, updatedAt: sql`now()` } })
    },
    async setLogo(logo, by) {
      return db.transaction(async (tx) => {
        const [old] = await tx.select(LOGO_SELECT).from(companyProfile).where(eq(companyProfile.id, ROW)).for('update')
        const set = { ...columnsOf(logo), updatedBy: by }
        await tx
          .insert(companyProfile)
          .values({ id: ROW, ...set })
          .onConflictDoUpdate({ target: companyProfile.id, set: { ...set, updatedAt: sql`now()` } })
        return { previous: old ? logoOf(old) : null }
      })
    },
  }
}

/** The store for the current request's database. */
export function companyProfileStore(): CompanyProfileStore {
  return dbCompanyProfileStore(getDb())
}

/** In memory, for specs that exercise the identity without Postgres. */
export function memoryCompanyProfileStore(initial: CompanyProfile | null = null): CompanyProfileStore & { row: CompanyProfile | null } {
  const state = {
    row: initial,
    async get() {
      return state.row ? { ...state.row } : null
    },
    async setName(name: string, by: string) {
      state.row = { name, logo: state.row?.logo ?? null, updatedBy: by, updatedAt: new Date() }
    },
    async setLogo(logo: CompanyLogo | null, by: string) {
      const previous = state.row?.logo ?? null
      state.row = { name: state.row?.name ?? null, logo, updatedBy: by, updatedAt: new Date() }
      return { previous }
    },
  }
  return state
}
