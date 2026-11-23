import { describe, expect, it } from 'vitest'
import { ExportPlanError, planCompanyExport, type TableRule } from './plan'

const catalog = {
  contact: ['id', 'owner_id', 'shared', 'name', 'email', 'created_at'],
  session: ['id', 'token', 'user_id'],
  llm_key: ['id', 'provider', 'api_key'],
}

const rules: Record<string, TableRule> = {
  contact: {
    export: 'private-as-meta',
    privateWhen: 'NOT t.shared',
    meta: ['id', 'owner_id', 'shared', 'created_at'],
    content: ['name', 'email'],
  },
  session: { export: 'excluded', reason: 'sign-in sessions; nobody moves them' },
  llm_key: { export: 'full', secret: ['api_key'] },
}

function problems(fn: () => unknown): string[] {
  try {
    fn()
  } catch (e) {
    if (e instanceof ExportPlanError) return e.problems
    throw e
  }
  throw new Error('expected an ExportPlanError')
}

describe('planCompanyExport', () => {
  it('plans every table: excluded with its reason, secrets dropped, private rows as metadata', () => {
    const plan = planCompanyExport(catalog, rules)
    expect(plan.map((p) => p.table)).toEqual(['contact', 'llm_key', 'session'])
    expect(plan[2]).toEqual({ table: 'session', export: 'excluded', reason: 'sign-in sessions; nobody moves them' })
    const key = plan[1]
    expect(key).toMatchObject({ export: 'rows', secret: ['api_key'], hasPrivate: false })
    expect(key.export === 'rows' && key.sql).toBe(`SELECT to_jsonb(t) - 'api_key' AS row FROM "llm_key" t`)
    const contact = plan[0]
    expect(contact.export === 'rows' && contact.sql).toBe(
      `SELECT CASE WHEN (NOT t.shared) THEN jsonb_build_object('id', t."id", 'owner_id', t."owner_id", 'shared', t."shared", 'created_at', t."created_at") || '{"_private": true}'::jsonb ELSE to_jsonb(t) END AS row FROM "contact" t`,
    )
  })

  it('refuses a table without a rule and a rule without a table', () => {
    const p = problems(() =>
      planCompanyExport({ ...catalog, new_thing: ['id'] }, { ...rules, gone: { export: 'full' } }),
    )
    expect(p).toContain('new_thing: no export rule (classify it in src/lib/server/export/company/rules.ts)')
    expect(p).toContain('gone: has a rule but is not in the database')
  })

  it('refuses an unclassified column on a table with private rows', () => {
    const p = problems(() =>
      planCompanyExport({ ...catalog, contact: [...catalog.contact, 'notes'] }, rules),
    )
    expect(p).toEqual(['contact.notes: unclassified column (meta, content or secret)'])
  })

  it('refuses a column named twice or a column that does not exist', () => {
    const p = problems(() =>
      planCompanyExport(catalog, {
        ...rules,
        contact: { ...(rules.contact as Extract<TableRule, { export: 'private-as-meta' }>), content: ['name', 'email', 'id', 'phone'] },
        llm_key: { export: 'full', secret: ['token'] },
      }),
    )
    expect(p).toEqual(
      expect.arrayContaining([
        'contact.id: named twice (meta, content and secret are exclusive)',
        'contact.phone: named in the rule but no such column',
        'llm_key.token: marked secret but no such column',
      ]),
    )
  })
})
