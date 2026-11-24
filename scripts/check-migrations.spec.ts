import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  BASELINED_MIGRATIONS,
  lintMigrations,
  migrationMarker,
  planMigration,
  splitStatements,
  tokenize,
} from './check-migrations.mjs'

const lintOne = (sql: string, tag = '9000_new') =>
  lintMigrations({ entries: [{ tag, sql }], baselined: new Set<string>() })

const whys = (sql: string) => lintOne(sql).map((f) => f.why)

describe('SQL tokenizer and statement splitter', () => {
  it('keeps semicolons inside strings, quoted identifiers, dollar quotes and comments', () => {
    const sql = [
      "INSERT INTO t VALUES ('a;b', 'it''s; fine');",
      'SELECT "we;ird" FROM x; -- a comment; with a semicolon',
      '/* block; /* nested; */ still comment; */ SELECT 1;',
      'DO $body$ BEGIN PERFORM 1; PERFORM $$x;y$$; END $body$;',
      "SELECT E'back\\'slash;';",
    ].join('\n')
    const statements = splitStatements(sql)
    expect(statements.map((s) => s.text)).toEqual([
      "INSERT INTO t VALUES ('a;b', 'it''s; fine')",
      'SELECT "we;ird" FROM x',
      'SELECT 1',
      'DO $body$ BEGIN PERFORM 1; PERFORM $$x;y$$; END $body$',
      "SELECT E'back\\'slash;'",
    ])
    expect(statements.map((s) => s.line)).toEqual([1, 2, 3, 4, 5])
  })

  it('a drop inside a string or a comment is not a statement', () => {
    expect(
      whys(
        "-- ALTER TABLE a DROP COLUMN b;\n/* DROP TABLE a; */\nINSERT INTO log VALUES ('DROP TABLE a; ALTER TABLE a DROP COLUMN b');",
      ),
    ).toEqual([])
  })

  it('fails loud on an unterminated string, comment or dollar quote', () => {
    expect(() => tokenize("SELECT 'open")).toThrow(/unterminated string.*line 1/)
    expect(() => tokenize('SELECT 1 /* open')).toThrow(/unterminated comment/)
    expect(() => tokenize('DO $x$ BEGIN END')).toThrow(/unterminated dollar-quoted/)
  })

  it('treats $1 as a parameter, not a dollar quote', () => {
    expect(splitStatements('SELECT $1; SELECT 2;').map((s) => s.text)).toEqual([
      'SELECT $1',
      'SELECT 2',
    ])
  })
})

describe('expand/contract lint: destructive statements need -- ee:contract', () => {
  it.each([
    ['DROP TABLE "contacts";', /drops a table/],
    ['DROP TABLE IF EXISTS public.contacts CASCADE;', /drops a table/],
    ['ALTER TABLE "website_services" DROP COLUMN IF EXISTS "host";', /drops a column/],
    ['ALTER TABLE ONLY t DROP c;', /drops a column/],
    ['ALTER TABLE t RENAME COLUMN a TO b;', /renames a column/],
    ['ALTER TABLE t RENAME a TO b;', /renames a column/],
    ['ALTER TABLE t RENAME TO t2;', /renames a table/],
    ['ALTER TABLE t ALTER COLUMN a TYPE bigint;', /changes a column's type/],
    ['ALTER TABLE t ALTER a SET DATA TYPE text USING a::text;', /changes a column's type/],
    ['ALTER TABLE t ALTER COLUMN a SET NOT NULL;', /SET NOT NULL/],
    ['ALTER TABLE t ALTER COLUMN a DROP DEFAULT;', /drops a column default/],
    ['ALTER TABLE t ADD COLUMN a text NOT NULL;', /NOT NULL column without a default/],
    ['ALTER TABLE t SET SCHEMA archive;', /moves .* to another schema/],
    ['DROP TYPE "status";', /drops a type/],
    ["ALTER TYPE status RENAME VALUE 'a' TO 'b';", /renames an enum value/],
    ["ALTER TYPE status DROP VALUE 'a';", /drops an enum value/],
    ['ALTER TYPE status RENAME TO state;', /renames a type/],
    ['DROP VIEW v;', /drops a view/],
    ['DROP MATERIALIZED VIEW mv;', /drops a materialized view/],
    ['DROP FUNCTION f(int);', /drops a function/],
    ['DROP SCHEMA s CASCADE;', /drops a schema/],
    ['DROP SEQUENCE s;', /drops a sequence/],
    ['ALTER VIEW v RENAME TO w;', /renames a view/],
  ])('%s', (sql, why) => {
    const findings = lintOne(sql)
    expect(findings).toHaveLength(1)
    expect(findings[0].why).toMatch(why)
  })

  it('reports file, line, statement and the way out', () => {
    const [finding] = lintOne(
      'CREATE TABLE a (id int);\n\nALTER TABLE "b" DROP COLUMN "c";',
      '0178_x',
    )
    expect(finding).toMatchObject({
      file: 'drizzle/0178_x.sql',
      line: 3,
      statement: 'ALTER TABLE "b" DROP COLUMN "c"',
    })
    expect(finding.message).toContain('drizzle/0178_x.sql:3')
    expect(finding.message).toContain('ALTER TABLE "b" DROP COLUMN "c"')
    expect(finding.message).toContain(
      'move it to a later `-- ee:contract` migration once no released app reads it',
    )
  })

  it('finds every destructive action of a multi-action ALTER TABLE', () => {
    expect(
      whys('ALTER TABLE t ADD COLUMN x int, DROP COLUMN y, ALTER COLUMN z TYPE text;'),
    ).toEqual([
      expect.stringMatching(/drops a column/),
      expect.stringMatching(/changes a column's type/),
    ])
    // A comma inside a type or a default does not split the action.
    expect(
      whys(
        "ALTER TABLE t ADD COLUMN x numeric(10, 2) NOT NULL DEFAULT 0, ADD COLUMN y text[] DEFAULT ARRAY['a', 'b'];",
      ),
    ).toEqual([])
  })

  it('looks inside DO blocks (they run at migration time)', () => {
    const sql = `DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE column_name = 'host') THEN
        ALTER TABLE website_services DROP COLUMN host;
      END IF;
    END $$;`
    expect(whys(sql)).toEqual([expect.stringMatching(/drops a column/)])
  })

  it('does not look inside function bodies (they do not run at migration time)', () => {
    expect(
      whys(
        'CREATE OR REPLACE FUNCTION f() RETURNS void LANGUAGE plpgsql AS $$ BEGIN DROP TABLE tmp; END $$;',
      ),
    ).toEqual([])
  })

  it('allows every additive statement', () => {
    const sql = `
      CREATE TABLE IF NOT EXISTS a (id uuid PRIMARY KEY, n text NOT NULL);
      ALTER TABLE b ADD COLUMN IF NOT EXISTS c text;
      ALTER TABLE b ADD COLUMN d text NOT NULL DEFAULT '';
      ALTER TABLE b ADD COLUMN e bigserial NOT NULL;
      ALTER TABLE b ADD COLUMN f int GENERATED ALWAYS AS IDENTITY NOT NULL;
      ALTER TABLE b ADD CONSTRAINT b_c_fk FOREIGN KEY (c) REFERENCES a(n);
      ALTER TABLE b ALTER COLUMN c DROP NOT NULL;
      ALTER TABLE b ALTER COLUMN c SET DEFAULT 'x';
      ALTER TABLE b DROP CONSTRAINT IF EXISTS b_old_check;
      ALTER TABLE b RENAME CONSTRAINT x TO y;
      ALTER TYPE status ADD VALUE IF NOT EXISTS 'archived';
      CREATE INDEX IF NOT EXISTS b_c_idx ON b (c);
      DROP INDEX IF EXISTS b_old_idx;
      DROP TRIGGER IF EXISTS t ON b;
      DROP POLICY IF EXISTS p ON b;
      UPDATE b SET c = 'x' WHERE c IS NULL;
      INSERT INTO a VALUES (gen_random_uuid(), 'n');
    `
    expect(lintOne(sql)).toEqual([])
  })

  it('an object created earlier in the same file is new: no released app reads it', () => {
    const sql = `
      CREATE TABLE "tmp_copy" (id int, v text);
      ALTER TABLE "tmp_copy" ALTER COLUMN v SET NOT NULL;
      ALTER TABLE tmp_copy ADD COLUMN w text NOT NULL;
      DROP TABLE tmp_copy;
      CREATE TYPE s AS ENUM ('a');
      DROP TYPE s;
    `
    expect(lintOne(sql)).toEqual([])
  })

  it('dropping a table and creating it again destroys data: still destructive', () => {
    expect(whys('DROP TABLE IF EXISTS a; CREATE TABLE a (id int);')).toEqual([
      expect.stringMatching(/drops a table/),
    ])
  })

  it('a view or function dropped and re-created in the same file is a redefinition', () => {
    expect(
      lintOne(
        'DROP VIEW IF EXISTS v; CREATE VIEW v AS SELECT 1 AS one; DROP FUNCTION IF EXISTS public.f(int); CREATE FUNCTION f(bigint) RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;',
      ),
    ).toEqual([])
  })

  it('a destructive statement is allowed in a file whose first line is -- ee:contract', () => {
    expect(lintOne('-- ee:contract\nALTER TABLE t DROP COLUMN c;\nDROP TABLE old;')).toEqual([])
  })

  it('baselined migrations are not linted for destructive statements', () => {
    expect(
      lintMigrations({
        entries: [{ tag: '0165_old', sql: 'ALTER TABLE t DROP COLUMN c;' }],
        baselined: new Set(['0165_old']),
      }),
    ).toEqual([])
  })

  it('the runner owns transactions: BEGIN/COMMIT/ROLLBACK in a file are refused', () => {
    expect(whys('BEGIN; CREATE TABLE a (id int); COMMIT;')).toEqual([
      expect.stringMatching(/transaction control/),
      expect.stringMatching(/transaction control/),
    ])
  })

  it('a marker anywhere but the first line, or an unknown marker, is refused', () => {
    expect(whys('CREATE TABLE a (id int);\n-- ee:contract\nDROP TABLE b;')).toEqual([
      expect.stringMatching(/must be the first line/),
      expect.stringMatching(/drops a table/),
    ])
    expect(whys('-- ee:contracts\nDROP TABLE b;')).toEqual([
      expect.stringMatching(/unknown marker/),
      expect.stringMatching(/drops a table/),
    ])
  })
})

describe('-- ee:no-transaction', () => {
  it('allows only statements that cannot run in a transaction', () => {
    expect(
      lintOne(
        "-- ee:no-transaction\nCREATE INDEX CONCURRENTLY IF NOT EXISTS a_b_idx ON a (b);\nDROP INDEX CONCURRENTLY IF EXISTS a_c_idx;\nALTER TYPE status ADD VALUE IF NOT EXISTS 'x';\nREINDEX INDEX CONCURRENTLY a_b_idx;",
      ),
    ).toEqual([])
    expect(
      whys(
        '-- ee:no-transaction\nCREATE INDEX CONCURRENTLY a_b_idx ON a (b);\nALTER TABLE a ADD COLUMN c int;',
      ),
    ).toEqual([expect.stringMatching(/outside a transaction/)])
  })

  it('plans single statements run one by one; an ordinary file runs its breakpoint chunks in one transaction', () => {
    expect(
      planMigration(
        '-- ee:no-transaction\nCREATE INDEX CONCURRENTLY a ON t (b);\nCREATE INDEX CONCURRENTLY c ON t (d);',
        'x',
      ),
    ).toEqual({
      mode: 'no-transaction',
      statements: ['CREATE INDEX CONCURRENTLY a ON t (b)', 'CREATE INDEX CONCURRENTLY c ON t (d)'],
    })
    expect(
      planMigration(
        'CREATE TABLE a (id int);\n--> statement-breakpoint\nCREATE TABLE b (id int);',
        'x',
      ),
    ).toEqual({
      mode: 'transaction',
      statements: ['CREATE TABLE a (id int);', 'CREATE TABLE b (id int);'],
    })
    expect(() => planMigration('-- ee:no-transaction\nCREATE TABLE a (id int);', '9000_x')).toThrow(
      /9000_x.*outside a transaction/,
    )
    expect(() => planMigration('-- ee:nope\nSELECT 1;', '9000_x')).toThrow(/unknown marker/)
  })

  it('reads the marker from the first line only', () => {
    expect(migrationMarker('-- ee:contract\r\nDROP TABLE a;')).toBe('contract')
    expect(migrationMarker('-- ee:no-transaction  \nSELECT 1;')).toBe('no-transaction')
    expect(migrationMarker('SELECT 1;\n-- ee:contract')).toBe(null)
  })
})

describe('the repository migrations', () => {
  const drizzle = path.join(path.dirname(fileURLToPath(import.meta.url)), '../drizzle')
  const journal = JSON.parse(readFileSync(path.join(drizzle, 'meta/_journal.json'), 'utf-8')) as {
    entries: Array<{ tag: string; idx: number }>
  }

  it('baselines every migration up to and including idx 177 (0177_coworker_event_routes), listed by name', () => {
    const upTo177 = journal.entries.filter((e) => e.idx <= 177).map((e) => e.tag)
    expect([...BASELINED_MIGRATIONS]).toEqual(upTo177)
    expect(BASELINED_MIGRATIONS.at(-1)).toBe('0177_coworker_event_routes')
  })

  it('are all clean under the lint (with the baseline)', () => {
    const entries = journal.entries.map((e) => ({
      tag: e.tag,
      sql: readFileSync(path.join(drizzle, `${e.tag}.sql`), 'utf-8'),
    }))
    expect(
      lintMigrations({ entries, baselined: new Set(BASELINED_MIGRATIONS) }).map((f) => f.message),
    ).toEqual([])
  })

  it('without the baseline the lint finds 0165 dropping website_services.host (the planning finding)', () => {
    const sql = readFileSync(path.join(drizzle, '0165_website_services_drop_host.sql'), 'utf-8')
    expect(lintOne(sql, '0165_website_services_drop_host').map((f) => f.why)).toEqual([
      expect.stringMatching(/drops a column/),
    ])
  })
})
