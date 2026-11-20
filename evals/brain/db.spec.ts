import { describe, expect, it } from 'vitest'
import { EVAL_BRAIN_DATABASE, evalBrainDatabaseUrl } from './db'

describe('the eval company lives in its own database on the local test Postgres', () => {
  it('same server and credentials, the eval database name', () => {
    const url = evalBrainDatabaseUrl('postgres://u:p@localhost:5433/eigen?sslmode=disable')
    expect(url).toBe(`postgres://u:p@localhost:5433/${EVAL_BRAIN_DATABASE}?sslmode=disable`)
  })

  it('refuses anything but a local server — it truncates every table it owns', () => {
    expect(() => evalBrainDatabaseUrl('postgres://u:p@db.example.com:5432/eigen')).toThrow(/local test Postgres/)
    expect(() => evalBrainDatabaseUrl('postgres://u:p@127.0.0.1:5433/eigen')).not.toThrow()
  })

  it('a per-run database name, plain identifiers only (it is spliced into DROP/CREATE DATABASE)', () => {
    expect(evalBrainDatabaseUrl('postgres://u:p@localhost:5433/eigen', 'ee_eval_brain_gate_42')).toBe('postgres://u:p@localhost:5433/ee_eval_brain_gate_42')
    expect(() => evalBrainDatabaseUrl('postgres://u:p@localhost:5433/eigen', 'x; drop table y')).toThrow(/plain database name/)
  })

  it('refuses a missing or unparsable test URL', () => {
    expect(() => evalBrainDatabaseUrl('')).toThrow(/DATABASE_URL/)
    expect(() => evalBrainDatabaseUrl('not a url')).toThrow(/DATABASE_URL/)
  })
})
