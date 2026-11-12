import { eq, sql } from 'drizzle-orm'
import type { LogoType } from '$lib/company/identity'
import { companyProfile } from '$lib/server/db/company.schema'
import { getDb, type AppDatabase } from '$lib/server/db/context'

/** The company's one profile row (migration 0125): the name set in Settings → Company and the logo. */

export type CompanyLogo = { sha256: string; mime: LogoType }

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

const logoOf = (sha256: string | null, mime: LogoType | null): CompanyLogo | null => {
  if (sha256 === null && mime === null) return null
  // The table's pair check makes this impossible; a half logo is corruption, said loud.
  if (sha256 === null || mime === null) throw new Error('company_profile holds half a logo (sha256 and mime must be set together)')
  return { sha256, mime }
}

export function dbCompanyProfileStore(db: AppDatabase): CompanyProfileStore {
  return {
    async get() {
      const [row] = await db.select().from(companyProfile).where(eq(companyProfile.id, ROW)).limit(1)
      if (!row) return null
      return { name: row.name, logo: logoOf(row.logoSha256, row.logoMime), updatedBy: row.updatedBy, updatedAt: row.updatedAt }
    },
    async setName(name, by) {
      await db
        .insert(companyProfile)
        .values({ id: ROW, name, updatedBy: by })
        .onConflictDoUpdate({ target: companyProfile.id, set: { name, updatedBy: by, updatedAt: sql`now()` } })
    },
    async setLogo(logo, by) {
      return db.transaction(async (tx) => {
        const [old] = await tx
          .select({ sha256: companyProfile.logoSha256, mime: companyProfile.logoMime })
          .from(companyProfile)
          .where(eq(companyProfile.id, ROW))
          .for('update')
        const set = { logoSha256: logo?.sha256 ?? null, logoMime: logo?.mime ?? null, updatedBy: by }
        await tx
          .insert(companyProfile)
          .values({ id: ROW, ...set })
          .onConflictDoUpdate({ target: companyProfile.id, set: { ...set, updatedAt: sql`now()` } })
        return { previous: old ? logoOf(old.sha256, old.mime) : null }
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
