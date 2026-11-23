import { statfs } from 'node:fs/promises'
import { request } from 'node:http'
import { basename } from 'node:path'
import { BACKUP_SCOPE } from '../backup/service.ts'
import type { Ee } from '../daemon.ts'
import { saveJournal } from '../journal.ts'
import { emit, OS_INTERNAL_PORT } from '../reconcile.ts'
import { mustRun } from '../system.ts'
import { PATHS } from '../paths.ts'
import { FLEET_AUTHOR, UPGRADE_UNIT, type FleetHost } from './agent.ts'
import { writeClaims } from './claims.ts'
import { readHostedAddress, writeHostedAddress } from './hosted-address.ts'

/** GET on os's loopback port with the fleet bearer token; rejects on a connection error or timeout. */
/** os's answer as JSON; anything but a 200 with JSON throws, naming the status (never the body: it may echo secrets). */
function osJson(got: { status: number; raw: string }, path: string): unknown {
  if (got.status !== 200) throw new Error(`os answered ${got.status} on ${path}`)
  try {
    return JSON.parse(got.raw)
  } catch {
    throw new Error(`os answered ${path} with something that is not JSON`)
  }
}

function osGet(path: string, token: string): Promise<{ status: number; raw: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port: OS_INTERNAL_PORT, path, method: 'GET', timeout: 5000, headers: { authorization: `Bearer ${token}` } },
      (res) => {
        let raw = ''
        res.on('data', (d) => (raw += String(d)))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, raw }))
        res.on('error', reject)
      },
    )
    req.on('error', reject)
    req.on('timeout', () => {
      req.destroy()
      reject(new Error(`os did not answer ${path} within 5s`))
    })
    req.end()
  })
}

/** The real box behind the fleet agent: every effect goes through ee's own paths (Ee.change, BackupService, the System seam). */
export function fleetHost(ee: Ee): FleetHost {
  const sys = ee.sys
  return {
    read: async () => {
      const { rev: _rev, ...rest } = await ee.repo.read()
      return rest
    },
    change: (message, mutate) => ee.change(message, FLEET_AUTHOR, mutate),
    reconcile: async () => {
      await ee.reconcile()
    },
    secrets: ee.secrets,
    osRelease: async () => {
      const os = (await ee.repo.read()).workloads.find((w) => w.name === 'os')
      return os?.source.kind === 'release' ? basename(os.source.tarball) : null
    },
    osHealth: async () => {
      const j = ee.journal.workloads['os']
      if (!j?.active) return 'unknown'
      return (await sys.httpOk(OS_INTERNAL_PORT, '/api/health', 5000)) ? 'healthy' : 'unhealthy'
    },
    reconcileError: () => ee.lastReconcileError,
    disk: async () => {
      const s = await statfs('/var/lib')
      const gb = (blocks: number) => Math.round(((blocks * s.bsize) / 1e9) * 100) / 100
      return { usedGb: gb(s.blocks - s.bfree), totalGb: gb(s.blocks) }
    },
    seats: async (token) => {
      const n = (osJson(await osGet('/api/fleet/seats', token), '/api/fleet/seats') as { seats?: unknown }).seats
      if (typeof n === 'number' && Number.isInteger(n) && n >= 0) return n
      throw new Error('os answered /api/fleet/seats without a seat count')
    },
    mailDomains: async (token) => {
      const domains = (osJson(await osGet('/api/fleet/mail-domains', token), '/api/fleet/mail-domains') as { domains?: unknown }).domains
      const ok =
        Array.isArray(domains) &&
        domains.every((d) => d && typeof d === 'object' && typeof (d as { name?: unknown }).name === 'string' && typeof (d as { receive?: unknown }).receive === 'boolean')
      if (!ok) throw new Error('os answered /api/fleet/mail-domains without a domain list')
      return (domains as Array<{ name: string; receive: boolean }>).map((d) => ({ name: d.name, receive: d.receive }))
    },
    backupKey: async (token) => {
      let got: { status: number; raw: string }
      try {
        got = await osGet('/api/fleet/backup-key', token)
      } catch (err) {
        throw new Error(`os could not give the backup key: ${(err as Error).message}`, { cause: err })
      }
      // The body is never echoed: it may hold the key.
      if (got.status !== 200) throw new Error(`os could not give the backup key: HTTP ${got.status}`)
      let key: unknown
      try {
        key = (JSON.parse(got.raw) as { backupKey?: unknown }).backupKey
      } catch {
        key = undefined
      }
      if (typeof key !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(key)) throw new Error('os answered no valid backup key')
      return key
    },
    backups: {
      hasKey: () => ee.backups.key() !== null,
      key: () => ee.backups.key()?.toString('base64') ?? null,
      config: () => ee.backups.config(),
      configure: (input) => ee.backups.configure(input),
      unconfigure: async (author) => {
        // The target goes; the sealed backup key stays (it belongs to the company recovery code).
        await ee.secrets.delete(BACKUP_SCOPE, 'CONFIG')
        emit(ee.journal, sys, 'backup.unconfigured', null, `backups switched off by ${author}`)
        await saveJournal(sys, ee.journal)
      },
      status: () => ee.backups.status(),
      start: (trigger, author) => ee.backups.start(trigger, author),
      isRunning: () => ee.backups.isRunning(),
    },
    upgradeActive: async () => (await sys.run('systemctl', ['is-active', '--quiet', `${UPGRADE_UNIT}.service`])).code === 0,
    // Detached: the upgrade restarts ee.service, which must not take the upgrade down with it.
    startUpgrade: async (from, release) =>
      void (await mustRun(sys, 'systemd-run', [`--unit=${UPGRADE_UNIT}`, '--collect', '/usr/local/bin/ee', 'upgrade', '--from', from, '--expect', release])),
    fetch: (input, init) => fetch(input, init),
    now: () => sys.now(),
    log: async (type, message) => {
      console.error(`fleet: ${message}`)
      emit(ee.journal, sys, type, null, message)
      await saveJournal(sys, ee.journal)
    },
    saveClaims: async (claims) => {
      await writeClaims(sys, PATHS.fleetClaims, claims)
    },
    readHostedAddress: () => readHostedAddress(sys, PATHS.fleetHostedAddress),
    saveHostedAddress: async (record) => {
      await writeHostedAddress(sys, PATHS.fleetHostedAddress, record)
    },
  }
}
