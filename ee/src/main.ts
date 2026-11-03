import { z } from 'zod'
import { HOSTNAME } from './spec.ts'
import { request } from 'node:http'
import { parseArgs } from 'node:util'
import { bootstrap } from './bootstrap.ts'
import { CLAIM_TTL_DAYS, claimUrl } from './claim.ts'
import { CompanyRepo } from './company-repo.ts'
import { Ee, startControlServer } from './daemon.ts'
import { loadJournal } from './journal.ts'
import { PATHS } from './paths.ts'
import { renderLiveEnvFiles } from './reconcile.ts'
import { SecretStore } from './secret-store.ts'
import { RealSystem } from './system.ts'
import { createInterface } from 'node:readline'
import { backupKeyFromRecoveryCode } from './backup/crypto.ts'
import { S3Client, s3TargetSchema, type S3Target } from './backup/s3.ts'
import { BACKUP_SCOPE, storedConfigSchema } from './backup/service.ts'
import { fetchSnapshot, resolveSnapshot } from './backup/snapshot.ts'
import { restoreOnBox } from './backup/box.ts'

const USAGE = `ee — the company's init (plan/phase-substrate.md)

  ee bootstrap --release <tarball> [--console-host <host>] [--acme-email <email>]
  ee claim-link                          (new private link to claim this server)
  ee status
  ee reconcile
  ee domain add <host> [--workload os] [--role console|public|app]
  ee domain remove <host>
  ee secret set <workload> <NAME>        (value read from stdin)
  ee logs <workload>
  ee backup [--scheduled]                (take a snapshot now; the nightly timer passes --scheduled)
  ee backup status
  ee restore --snapshot <id|latest>      (asks for the company recovery code EE1-…; restores everything, then reconciles)
  ee restore --verify [--snapshot <id|latest>]   (download + decrypt + check, touches nothing)
      restore on a fresh server: --endpoint <url> --region <r> --bucket <b> [--prefix <p>]
      [--addressing path|virtual] --access-key-id <id>   (secret key asked on stdin)

  ee daemon        (run by ee.service)
  ee render-env    (run by ee-env.service at boot)
`

function call(method: string, path: string, body?: unknown): Promise<{ status: number; data: unknown }> {
  const text = body === undefined ? '' : JSON.stringify(body)
  return new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath: PATHS.controlSocket,
        path,
        method,
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) },
      },
      (res) => {
        let raw = ''
        res.on('data', (d) => (raw += String(d)))
        res.on('end', () => resolve({ status: res.statusCode ?? 500, data: raw ? JSON.parse(raw) : null }))
      },
    )
    req.on('error', (err) =>
      reject(new Error(`ee daemon unreachable at ${PATHS.controlSocket} (is ee.service running?): ${err.message}`, { cause: err })),
    )
    req.end(text)
  })
}

async function print(p: Promise<{ status: number; data: unknown }>): Promise<void> {
  const { status, data } = await p
  console.log(JSON.stringify(data, null, 2))
  const reconcileError = (data as { reconcileError?: string | null } | null)?.reconcileError
  if (status >= 400 || reconcileError) process.exitCode = 1
}

async function readStdin(): Promise<string> {
  let s = ''
  for await (const chunk of process.stdin) s += String(chunk)
  return s.replace(/\r?\n$/, '')
}

/** Read answers line by line from stdin (a TTY prompt, or piped in a drill script). */
function lineReader(): { next(): Promise<string>; close(): void } {
  const rl = createInterface({ input: process.stdin })
  const it = rl[Symbol.asyncIterator]()
  return {
    async next() {
      const { value, done } = await it.next()
      if (done) throw new Error('stdin closed before an answer was given')
      return String(value).trim()
    },
    close: () => rl.close(),
  }
}

const who = () => `owner:${process.env.SUDO_USER ?? process.env.USER ?? 'root'}`

async function main(argv: string[]): Promise<void> {
  const [cmd, ...rest] = argv
  const sys = new RealSystem()

  switch (cmd) {
    case 'bootstrap': {
      const { values } = parseArgs({
        args: rest,
        options: { release: { type: 'string' }, 'console-host': { type: 'string' }, 'acme-email': { type: 'string' } },
      })
      if (!values.release) throw new Error('--release <tarball> is required')
      // Check the flags up front, in plain words, before anything is installed.
      if (values['acme-email'] && !z.email().safeParse(values['acme-email']).success) {
        throw new Error(`--acme-email "${values['acme-email']}" is not a valid email address`)
      }
      if (values['console-host'] && !HOSTNAME.test(values['console-host'])) {
        throw new Error(`--console-host "${values['console-host']}" is not a valid host name (e.g. os.example.com)`)
      }
      const { consoleHost, claimToken } = await bootstrap(sys, {
        release: values.release,
        ...(values['console-host'] ? { consoleHost: values['console-host'] } : {}),
        ...(values['acme-email'] ? { acmeEmail: values['acme-email'] } : {}),
      })
      console.log('→ first deploy (health-gated; migrations run now, this takes a minute)')
      const ee = new Ee(sys, await SecretStore.open(sys))
      await ee.load()
      try {
        await ee.reconcile()
      } finally {
        // Always pick up the new ee: one app's failed deploy must never keep
        // the daemon on old code (its error is still reported after this).
        await sys.run('systemctl', ['restart', 'ee.service'])
      }
      if (claimToken) {
        console.log(`\n✓ Your company is running. Claim it — this private link makes you its owner:\n\n  ${claimUrl(consoleHost, claimToken)}\n\n  (works once, for ${CLAIM_TTL_DAYS} days; lost it? run: ee claim-link)\n`)
      } else {
        console.log(`\n✓ Your company is running: https://${consoleHost}\n`)
      }
      return
    }
    case 'daemon': {
      const ee = new Ee(sys, await SecretStore.open(sys))
      await ee.load()
      await startControlServer(ee)
      console.log(`ee daemon listening on ${PATHS.controlSocket}`)
      const tick = async () => {
        try {
          await ee.reconcile()
        } catch (err) {
          console.error(`reconcile: ${(err as Error).message}`)
        }
      }
      await tick()
      setInterval(tick, 60_000)
      return
    }
    case 'render-env': {
      const secrets = await SecretStore.open(sys)
      const repo = new CompanyRepo(sys, PATHS.company)
      if (!(await repo.head())) return
      const n = await renderLiveEnvFiles(sys, await repo.read(), await loadJournal(sys), secrets.all())
      console.log(`rendered ${n} workload env file(s)`)
      return
    }
    case 'claim-link': {
      const { status, data } = await call('POST', '/v1/claim', { author: who() })
      if (status >= 400) return print(Promise.resolve({ status, data }))
      const d = data as { url: string; expiresAt: string; reconcileError: string | null }
      console.log(`\nClaim link (works once, until ${d.expiresAt}):\n\n  ${d.url}\n`)
      if (d.reconcileError) {
        console.error(`✗ the server could not apply it yet: ${d.reconcileError}`)
        process.exitCode = 1
      }
      return
    }
    case 'status':
      return print(call('GET', '/v1/status'))
    case 'reconcile':
      return print(call('POST', '/v1/reconcile'))
    case 'domain': {
      const [verb, host, ...flags] = rest
      if (!host) throw new Error(USAGE)
      if (verb === 'add') {
        const { values } = parseArgs({ args: flags, options: { workload: { type: 'string' }, role: { type: 'string' } } })
        return print(call('POST', '/v1/domains', { host, workload: values.workload ?? 'os', role: values.role ?? 'app', author: who() }))
      }
      if (verb === 'remove') return print(call('DELETE', '/v1/domains', { host, author: who() }))
      throw new Error(USAGE)
    }
    case 'secret': {
      const [verb, workload, name] = rest
      if (verb !== 'set' || !workload || !name) throw new Error(USAGE)
      return print(call('POST', '/v1/secrets', { workload, name, value: await readStdin(), author: who() }))
    }
    case 'logs': {
      const [workload] = rest
      if (!workload) throw new Error(USAGE)
      const { data } = await call('GET', `/v1/logs?workload=${encodeURIComponent(workload)}`)
      console.log(((data as { lines?: string[] }).lines ?? [JSON.stringify(data)]).join('\n'))
      return
    }
    case 'backup': {
      if (rest[0] === 'status') return print(call('GET', '/v1/backups'))
      const { values } = parseArgs({ args: rest, options: { scheduled: { type: 'boolean' } } })
      const { status, data } = await call('POST', '/v1/backups/run', {
        author: values.scheduled ? 'ee-timer' : who(),
        trigger: values.scheduled ? 'scheduled' : 'manual',
        wait: true,
      })
      console.log(JSON.stringify(data, null, 2))
      const run = (data as { run?: { status?: string } } | null)?.run
      if (status >= 400 || (run && run.status !== 'succeeded')) process.exitCode = 1
      return
    }
    case 'restore': {
      const { values } = parseArgs({
        args: rest,
        options: {
          snapshot: { type: 'string' },
          verify: { type: 'boolean' },
          endpoint: { type: 'string' },
          region: { type: 'string' },
          bucket: { type: 'string' },
          prefix: { type: 'string' },
          addressing: { type: 'string' },
          'access-key-id': { type: 'string' },
        },
      })
      if (!values.verify && !values.snapshot) throw new Error('--snapshot <id|latest> is required (or --verify)')
      if (!values.verify && process.getuid?.() !== 0) throw new Error('ee restore must run as root')
      const ask = lineReader()
      let target: S3Target
      if (values.endpoint || values.bucket) {
        console.error('S3 secret access key:')
        target = s3TargetSchema.parse({
          endpoint: values.endpoint,
          region: values.region ?? 'us-east-1',
          bucket: values.bucket,
          prefix: values.prefix ?? '',
          addressing: values.addressing ?? 'path',
          accessKeyId: values['access-key-id'],
          secretAccessKey: await ask.next(),
        })
      } else {
        const raw = (await SecretStore.open(sys)).all()[BACKUP_SCOPE]?.['CONFIG']
        if (!raw) ask.close()
        if (!raw) throw new Error('backups are not set up on this server: pass --endpoint --region --bucket [--prefix] --access-key-id')
        target = storedConfigSchema.parse(JSON.parse(raw)).target
      }
      console.error('Company recovery code (EE1-…):')
      const key = backupKeyFromRecoveryCode(await ask.next())
      ask.close()
      const s3 = new S3Client(target)
      const id = await resolveSnapshot(s3, values.snapshot ?? 'latest')
      if (values.verify) {
        console.log(`→ verifying snapshot ${id} (nothing is written)`)
        const m = await fetchSnapshot(s3, key, id, null, (l) => console.log(l))
        console.log(`✓ snapshot ${id} is complete and decrypts: ${m.files.length} file(s), ${m.blobs.length} Drive blob(s)`)
        return
      }
      await restoreOnBox(sys, s3, key, id, (l) => console.log(l))
      console.log(`✓ restored snapshot ${id}. ee is reconciling now: watch \`ee status\``)
      return
    }
    default:
      process.stdout.write(USAGE)
      if (cmd && cmd !== 'help' && cmd !== '--help') process.exitCode = 2
  }
}

main(process.argv.slice(2)).catch((err) => {
  console.error(`✗ ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
