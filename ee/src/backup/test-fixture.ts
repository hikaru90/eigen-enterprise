import type { BackupSources } from './snapshot.ts'
import { createHash, randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/** A fake company on disk: a "pg_dump", Drive blobs, a WAL-mode agent.sqlite, ee state files. */
export async function companyFixture(): Promise<{ root: string; sources: BackupSources; addBlob(content?: Buffer): Promise<string> }> {
  const root = await mkdtemp(join(tmpdir(), 'ee-backup-'))
  const driveDir = join(root, 'os', 'drive')
  const agentDir = join(root, 'os', 'agent')
  await mkdir(agentDir, { recursive: true })
  await mkdir(join(root, 'ee', 'company'), { recursive: true })
  await writeFile(join(root, 'ee', 'company', 'desired.json'), '{"workloads":["os"]}')
  await writeFile(join(root, 'ee', 'secrets.enc'), 'ee-secrets-v1.sealed')
  const db = new DatabaseSync(join(agentDir, 'agent.sqlite'))
  db.exec("PRAGMA journal_mode=WAL; CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('turn-1'), ('turn-2');")
  db.close()
  const addBlob = async (content = randomBytes(100)) => {
    const sha = createHash('sha256').update(content).digest('hex')
    const dir = join(driveDir, 'blobs', sha.slice(0, 2), sha.slice(2, 4))
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, sha), content)
    return sha
  }
  return {
    root,
    addBlob,
    sources: {
      dbDump: ['sh', '-c', 'printf "PGDMP-fake-company-dump"'],
      driveDir,
      agentDb: join(agentDir, 'agent.sqlite'),
      eeState: [join(root, 'ee', 'company'), join(root, 'ee', 'secrets.enc')],
      tmpDir: join(root, 'tmp'),
    },
  }
}
