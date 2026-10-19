import { eq } from 'drizzle-orm'
import { companyMail as companyMailTable } from '$lib/server/db/company-mail.schema'
import { env } from '$lib/server/env/private-env'
import type { OwleryEnv } from '$lib/server/owlery/config'
import { CompanyMail, mailSealKey, type CompanyMailRow, type CompanyMailStore } from './company-mail'

export { CompanyMail, MailNotConfiguredError } from './company-mail'

/** Postgres store for the company mail row (company-level: no RLS, like kernel tables). */
class DbCompanyMailStore implements CompanyMailStore {
  private async db() {
    const { appSql, createScopedDrizzle } = await import('$lib/server/db')
    return createScopedDrizzle(appSql)
  }
  async read(): Promise<CompanyMailRow | null> {
    const [row] = await (await this.db()).select().from(companyMailTable).where(eq(companyMailTable.id, 'mail')).limit(1)
    if (!row) return null
    return {
      provider: row.provider,
      baseUrl: row.baseUrl,
      emailFrom: row.emailFrom,
      contactBookId: row.contactBookId,
      sealedApiKey: row.sealedApiKey,
      updatedBy: row.updatedBy,
    }
  }
  async write(r: CompanyMailRow): Promise<void> {
    const values = { id: 'mail', ...r, updatedAt: new Date() }
    await (await this.db()).insert(companyMailTable).values(values).onConflictDoUpdate({ target: companyMailTable.id, set: values })
  }
}

const host = globalThis as { __eeCompanyMail?: CompanyMail }

/** The process-wide company mail (cached settings, invalidated on save). */
export function companyMail(): CompanyMail {
  host.__eeCompanyMail ??= new CompanyMail({
    store: new DbCompanyMailStore(),
    key: () => {
      const master = env.TENANT_MASTER_KEY
      if (!master) throw new Error('TENANT_MASTER_KEY is required to unseal the email provider key')
      return mailSealKey(master)
    },
  })
  return host.__eeCompanyMail
}

/** For the existing Owlery clients: this company's Owlery env, or {} when email isn't set up (they fail loud). */
export async function companyOwleryEnv(): Promise<OwleryEnv> {
  return (await companyMail().owleryEnv()) ?? {}
}
