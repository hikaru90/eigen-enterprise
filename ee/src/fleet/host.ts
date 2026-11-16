import { statfs } from 'node:fs/promises'
import { request } from 'node:http'
import { basename } from 'node:path'
import { BACKUP_SCOPE } from '../backup/service.ts'
import type { Ee } from '../daemon.ts'
import { saveJournal } from '../journal.ts'
import { emit, OS_INTERNAL_PORT } from '../reconcile.ts'
import { mustRun } from '../system.ts'
import { FLEET_AUTHOR, UPGRADE_UNIT, type FleetHost } from './agent.ts'

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
    seats: (token) =>
      new Promise((resolve) => {
        const req = request(
          { host: '127.0.0.1', port: OS_INTERNAL_PORT, path: '/api/fleet/seats', method: 'GET', timeout: 5000, headers: { authorization: `Bearer ${token}` } },
          (res) => {
            let raw = ''
            res.on('data', (d) => (raw += String(d)))
            res.on('end', () => {
              try {
                const n = (JSON.parse(raw) as { seats?: unknown }).seats
                resolve(res.statusCode === 200 && typeof n === 'number' && Number.isInteger(n) && n >= 0 ? n : null)
              } catch {
                resolve(null)
              }
            })
          },
        )
        req.on('error', () => resolve(null))
        req.on('timeout', () => {
          req.destroy()
          resolve(null)
        })
        req.end()
      }),
    backups: {
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
    startUpgrade: async (from) => void (await mustRun(sys, 'systemd-run', [`--unit=${UPGRADE_UNIT}`, '--collect', '/usr/local/bin/ee', 'upgrade', '--from', from])),
    fetch: (input, init) => fetch(input, init),
    now: () => sys.now(),
    log: async (type, message) => {
      console.error(`fleet: ${message}`)
      emit(ee.journal, sys, type, null, message)
      await saveJournal(sys, ee.journal)
    },
  }
}
