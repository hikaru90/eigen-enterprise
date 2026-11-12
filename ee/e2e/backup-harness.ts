import type { SecretMap } from '../src/secrets.ts'
/**
 * A backup-only ee for the browser e2e (src/routes/e2e/backups.e2e.ts): the
 * real BackupService + control routes on a temp unix socket, taking real
 * snapshots of the dev harness's company (the test DB via pg_dump in its
 * container, the harness Drive dir and agent state) into a real S3 (MinIO).
 * Only the systemd timer is stubbed — there is no systemd here.
 *
 *   node <bundled harness> <socketPath> <workDir> <dbDumpArgvJson> <driveDir> <agentDb>
 *
 * Extra harness verb on the same socket: GET /harness/objects → every key in
 * the configured bucket (proof that objects exist, read with ee's S3 client).
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { backupRoute } from '../src/backup/control.ts'
import { BackupService } from '../src/backup/service.ts'

const [socketPath, workDir, dumpJson, driveDir, agentDb] = process.argv.slice(2)
if (!socketPath || !workDir || !dumpJson || !driveDir || !agentDb) {
  console.error('usage: backup-harness <socket> <workDir> <dbDumpArgvJson> <driveDir> <agentDb>')
  process.exit(2)
}

await mkdir(join(workDir, 'ee', 'company'), { recursive: true })
await writeFile(join(workDir, 'ee', 'company', 'desired.json'), JSON.stringify({ harness: true }))
await writeFile(join(workDir, 'ee', 'secrets.enc'), 'ee-secrets-v1.harness')
let secrets: SecretMap = {}
const events: Array<{ type: string; message: string }> = []

const svc = new BackupService({
  secrets: {
    all: () => secrets,
    set: async (w, n, v) => {
      secrets = { ...secrets, [w]: { ...(secrets[w] ?? {}), [n]: v } }
    },
  },
  readFile: async (p) => readFile(p, 'utf8').catch(() => null),
  writeFile: async (p, c) => writeFile(p, c, { mode: 0o600 }),
  runsFile: join(workDir, 'backups.json'),
  sources: {
    dbDump: JSON.parse(dumpJson) as string[],
    driveDir,
    agentDb,
    eeState: [join(workDir, 'ee', 'company'), join(workDir, 'ee', 'secrets.enc')],
    tmpDir: join(workDir, 'tmp'),
  },
  now: () => new Date(),
  emit: async (type, message) => void events.push({ type, message }),
  applySchedule: async () => undefined,
  // No check/restore in this harness: nothing else ever holds the job slot.
  busy: () => null,
  partSize: 5 * 1024 * 1024,
})

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://ee')
  const route = `${req.method} ${url.pathname}`
  const readBody = async () => {
    let raw = ''
    for await (const c of req) raw += String(c)
    return raw ? JSON.parse(raw) : {}
  }
  try {
    if (route === 'GET /harness/objects') {
      const cfg = svc.config()
      const objects = cfg ? await svc.client(cfg.target).list(cfg.target.prefix ? `${cfg.target.prefix}/` : '') : []
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ objects, events }))
    }
    const r = await backupRoute(svc, route, readBody)
    if (!r) {
      res.writeHead(404, { 'content-type': 'application/problem+json' })
      return res.end(JSON.stringify({ title: `harness: no verb ${route}`, detail: `harness: no verb ${route}` }))
    }
    res.writeHead(r.status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(r.data))
  } catch (err) {
    const detail = (err as Error).message
    res.writeHead(err instanceof Error && err.name === 'ZodError' ? 400 : 500, { 'content-type': 'application/problem+json' })
    res.end(JSON.stringify({ title: detail, detail }))
  }
})
await rm(socketPath, { force: true })
server.listen(socketPath, () => console.log(`backup harness listening on ${socketPath}`))
process.on('SIGTERM', () => server.close(() => process.exit(0)))
