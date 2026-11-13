import { spawn } from 'node:child_process'
import { readdir, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import { isIP } from 'node:net'
import { basename } from 'node:path'
import { createInterface } from 'node:readline'
import { parseArgs } from 'node:util'
import { z } from 'zod'
import { applyRestore, restoreOnBox } from './backup/box.ts'
import { backupKeyFromRecoveryCode } from './backup/crypto.ts'
import { S3Client, s3TargetSchema, type S3Target } from './backup/s3.ts'
import { BACKUP_SCOPE, storedConfigSchema } from './backup/service.ts'
import { runApply, SNAPSHOT_ID } from './backup/restore.ts'
import { fetchSnapshot, resolveSnapshot } from './backup/snapshot.ts'
import { bootstrap } from './bootstrap.ts'
import { CLAIM_TTL_DAYS, claimUrl } from './claim.ts'
import { CompanyRepo } from './company-repo.ts'
import { Ee, startControlServer } from './daemon.ts'
import { loadJournal } from './journal.ts'
import { PATHS } from './paths.ts'
import { renderLiveEnvFiles } from './reconcile.ts'
import { SecretStore } from './secret-store.ts'
import { HOSTNAME } from './spec.ts'
import { mustRun, RealSystem } from './system.ts'
import { RELEASES_URL, UPGRADES_DIR, upgrade, type Arch } from './upgrade.ts'
import { parseContributeHubFlag } from './contribute-hub.ts'

const USAGE = `ee — the company's init (plan/phase-substrate.md)

  ee bootstrap --release <tarball> --livekit-release <tarball> [--console-host <host>]
               [--acme-email <email>] [--node-ip <ip>]   (--node-ip: the public IP calls media
                                         reach this server on; required once, then kept)
  ee upgrade [--check] [--from <release-url>] [--node-ip <ip>]   (update over the air to the newest
                                         release; keeps everything, takes a safety copy first)
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
  ee restore-apply --snapshot <id>   (run by ee-restore.service, which Settings → Backups starts
                                      through ee after it verified and staged that snapshot)
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
        options: {
          release: { type: 'string' },
          'livekit-release': { type: 'string' },
          'console-host': { type: 'string' },
          'acme-email': { type: 'string' },
          'node-ip': { type: 'string' },
          'contribute-hub': { type: 'string' },
        },
      })
      if (!values.release) throw new Error('--release <tarball> is required')
      if (!values['livekit-release']) throw new Error('--livekit-release <tarball> is required (install.sh passes it)')
      if (values['node-ip'] && isIP(values['node-ip']) === 0) {
        throw new Error(`--node-ip "${values['node-ip']}" is not an IP address`)
      }
      // Check the flags up front, in plain words, before anything is installed.
      if (values['acme-email'] && !z.email().safeParse(values['acme-email']).success) {
        throw new Error(`--acme-email "${values['acme-email']}" is not a valid email address`)
      }
      if (values['console-host'] && !HOSTNAME.test(values['console-host'])) {
        throw new Error(`--console-host "${values['console-host']}" is not a valid host name (e.g. os.example.com)`)
      }
      const contributeHub = values['contribute-hub'] === undefined ? undefined : parseContributeHubFlag(values['contribute-hub'])
      const { consoleHost, claimToken } = await bootstrap(sys, {
        release: values.release,
        livekitRelease: values['livekit-release'],
        ...(values['console-host'] ? { consoleHost: values['console-host'] } : {}),
        ...(values['acme-email'] ? { acmeEmail: values['acme-email'] } : {}),
        ...(values['node-ip'] ? { nodeIp: values['node-ip'] } : {}),
        ...(contributeHub ? { contributeHub } : {}),
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
    case 'upgrade': {
      const { values } = parseArgs({
        args: rest,
        options: { check: { type: 'boolean' }, from: { type: 'string' }, 'node-ip': { type: 'string' } },
      })
      if (process.getuid?.() !== 0) throw new Error('ee upgrade must run as root')
      if (values['node-ip'] && isIP(values['node-ip']) === 0) {
        throw new Error(`--node-ip "${values['node-ip']}" is not an IP address`)
      }
      const arch: Arch = process.arch === 'x64' || process.arch === 'arm64' ? process.arch : (() => {
        throw new Error(`unsupported CPU ${process.arch}`)
      })()
      const get = async (url: string) => {
        const res = await fetch(url, { redirect: 'follow' })
        if (!res.ok) throw new Error(`GET ${url} → ${res.status}`)
        return res
      }
      const result = await upgrade(
        {
          fetchText: async (url) => (await get(url)).text(),
          download: async (url, dest) => writeFile(dest, Buffer.from(await (await get(url)).arrayBuffer()), { mode: 0o600 }),
          run: (cmd, args) => sys.run(cmd, args, { timeoutMs: 1_800_000 }),
          runLive: (cmd, args) =>
            new Promise((resolve, reject) => {
              spawn(cmd, args, { stdio: 'inherit' }).on('error', reject).on('exit', (code) => resolve(code ?? 1))
            }),
          installed: async () => {
            const os = (await new CompanyRepo(sys, PATHS.company).read()).workloads.find((w) => w.name === 'os')
            return os?.source.kind === 'release' ? basename(os.source.tarball) : null
          },
          listUpgrades: async () => readdir(UPGRADES_DIR).catch((err: NodeJS.ErrnoException) => {
            if (err.code === 'ENOENT') return []
            throw err
          }),
          mkdirp: (p) => sys.mkdirp(p, 0o700),
          writeFile: (p, content) => sys.writeFile(p, content, 0o600),
          remove: (p) => sys.remove(p),
          now: () => new Date(),
          log: (l) => console.log(l),
        },
        {
          from: values.from ?? RELEASES_URL,
          arch,
          check: values.check === true,
          ...(values['node-ip'] ? { nodeIp: values['node-ip'] } : {}),
        },
      )
      if (values.check && result === 'available') console.log('  run `ee upgrade` to install it')
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
    case 'restore-apply': {
      // The second half of a restore started in Settings → Backups (backup/restore.ts): the daemon
      // verified and staged the snapshot, then started this as ee-restore.service, which outlives
      // ee.service. No key here: the staged files are already decrypted and checked.
      const { values } = parseArgs({ args: rest, options: { snapshot: { type: 'string' } } })
      if (!values.snapshot || !SNAPSHOT_ID.test(values.snapshot)) throw new Error('--snapshot <id> (e.g. 20261103T031700Z) is required')
      if (process.getuid?.() !== 0) throw new Error('ee restore-apply must run as root')
      const id = values.snapshot
      await runApply(
        {
          readFile: (p) => sys.readFile(p),
          writeFile: (p, c, m) => sys.writeFile(p, c, m),
          stateFile: PATHS.restoreState,
          now: () => new Date(),
          startEe: async () => void (await mustRun(sys, 'systemctl', ['start', 'ee.service'])),
        },
        id,
        (progress) => applyRestore(sys, id, progress),
        (l) => console.log(l),
      )
      console.log(`✓ restored snapshot ${id}. ee is reconciling now`)
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
