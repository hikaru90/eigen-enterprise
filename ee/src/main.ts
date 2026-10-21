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

const USAGE = `ee — the company's init (plan/phase-substrate.md)

  ee bootstrap --release <tarball> [--console-host <host>] [--acme-email <email>]
  ee claim-link                          (new private link to claim this server)
  ee status
  ee reconcile
  ee domain add <host> [--workload os] [--role console|public|app]
  ee domain remove <host>
  ee secret set <workload> <NAME>        (value read from stdin)
  ee logs <workload>

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
    default:
      process.stdout.write(USAGE)
      if (cmd && cmd !== 'help' && cmd !== '--help') process.exitCode = 2
  }
}

main(process.argv.slice(2)).catch((err) => {
  console.error(`✗ ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
