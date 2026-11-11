import { EE_API_URL, type AppContract, type Workload } from './spec.ts'
import { PATHS } from './paths.ts'

/**
 * Generated systemd units (§3.5, D2, D5). Every unit comes from this template;
 * the hardening block is not configurable. The one spec field that touches it is
 * `ports` (system tier, allow-listed): it adds those binds, AF_NETLINK and ProcSubset=all, nothing else.
 */

export type Slot = 'a' | 'b'

export type UnitInput = {
  workload: Workload
  contract: AppContract
  slot: Slot
  port: number
  /** Absolute path of the release this slot runs. */
  releaseDir: string
  /** Extra groups (only the install template grants these — e.g. ee-control for os). */
  supplementaryGroups?: string[]
}

export function unitName(workload: string, slot: Slot): string {
  return `ee-${workload}-${slot}.service`
}

/** Escape a value for a systemd `Environment=` assignment. */
function envAssignment(key: string, value: string): string {
  const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')
  return `Environment="${key}=${escaped}"`
}

/** Escape one argv element for ExecStart (systemd splits on whitespace, honours quotes). */
function execArg(arg: string): string {
  if (/^[A-Za-z0-9_./:=@+-]+$/.test(arg)) return arg.replace(/%/g, '%%')
  return `"${arg.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')}"`
}

export function execLine(argv: string[], nodeBin: string): string {
  const [first, ...rest] = argv
  // node/npm/npx resolve to the pinned runtime the contract declared, never the host's
  // (npm start is how most Node apps start — Nixpacks and Coolify run it too).
  const runtimeDir = nodeBin.slice(0, nodeBin.lastIndexOf('/'))
  const program = first === 'node' || first === 'npm' || first === 'npx' ? `${runtimeDir}/${first}` : first
  if (!program) throw new Error('empty argv')
  if (!program.startsWith('/') && !program.startsWith('./')) {
    throw new Error(`argv[0] must be "node", an absolute path or ./relative: ${program}`)
  }
  return [program, ...rest].map(execArg).join(' ')
}

export const HARDENING = [
  'DynamicUser=yes',
  'NoNewPrivileges=yes',
  'ProtectSystem=strict',
  'ProtectHome=yes',
  'PrivateTmp=yes',
  'PrivateDevices=yes',
  'ProtectKernelTunables=yes',
  'ProtectKernelModules=yes',
  'ProtectKernelLogs=yes',
  'ProtectControlGroups=yes',
  'ProtectClock=yes',
  'ProtectHostname=yes',
  'ProtectProc=invisible',
  'ProcSubset=pid',
  'RestrictNamespaces=yes',
  'RestrictRealtime=yes',
  'RestrictSUIDSGID=yes',
  'LockPersonality=yes',
  'MemoryDenyWriteExecute=no', // V8's JIT needs W+X pages; everything else stays locked.
  'RemoveIPC=yes',
  'CapabilityBoundingSet=',
  'AmbientCapabilities=',
  'SystemCallArchitectures=native',
  'SystemCallFilter=@system-service',
  'SystemCallFilter=~@privileged @resources',
  'RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6',
  'UMask=0077',
] as const

const PLAIN_FAMILIES = 'RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6'
/**
 * A workload that binds host ports is a media server (LiveKit): its UDP mux
 * binds the port on each interface, and Go lists interfaces over a netlink
 * route socket. Read-only without CAP_NET_ADMIN (the bounding set is empty).
 */
const HOST_PORT_FAMILIES = 'RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK'

/**
 * A media server also reads system-wide /proc counters (LiveKit's node load: /proc/loadavg,
 * /proc/stat). ProcSubset=pid hides them (LiveKit then logs an ERROR every 2 s, seen on the
 * box 2026-11-11). Still read-only (ProtectKernelTunables), other processes still invisible (ProtectProc).
 */
const PLAIN_PROC = 'ProcSubset=pid'
const HOST_PORT_PROC = 'ProcSubset=all'

/** The hardening block for this workload: HARDENING, verbatim, unless it opens host ports. */
function hardeningFor(w: Workload): string[] {
  if ((w.ports ?? []).length === 0) return [...HARDENING]
  return HARDENING.map((line) => (line === PLAIN_FAMILIES ? HOST_PORT_FAMILIES : line === PLAIN_PROC ? HOST_PORT_PROC : line))
}

/** How the unit starts: node resolves to the pinned runtime; binary runs from the release. */
function startSpec(input: UnitInput): { exec: (argv: string[]) => string; runtimeEnv: Record<string, string>; npm: boolean } {
  const { workload: w, contract: c, releaseDir } = input
  if (c.runtime === 'node' && c.start && c.node) {
    const nodeBin = `${PATHS.runtimes}/node-${c.node}/bin/node`
    return {
      exec: (argv) => execLine(argv, nodeBin),
      runtimeEnv: { NODE_ENV: 'production', PATH: `${PATHS.runtimes}/node-${c.node}/bin:/usr/bin:/bin` },
      npm: true,
    }
  }
  if (c.runtime === 'binary' && c.start) {
    if (w.tier !== 'system') throw new Error(`renderUnit: ${w.name} is a ${w.tier} workload; runtime "binary" is for system workloads only`)
    return {
      // Absolute: systemd resolves a bare name via PATH, never via WorkingDirectory.
      exec: ([program, ...rest]) => {
        if (!program?.startsWith('./')) throw new Error(`renderUnit: ${w.name}: a binary starts as ./<path>, got ${program}`)
        return [`${releaseDir}/${program.slice(2)}`, ...rest].map(execArg).join(' ')
      },
      runtimeEnv: { PATH: '/usr/bin:/bin' },
      npm: false,
    }
  }
  throw new Error(`renderUnit: ${w.name} is not a node or binary workload`)
}

export function renderUnit(input: UnitInput): string {
  const { workload: w, contract: c, slot, port, releaseDir } = input
  const start = startSpec(input)
  const env: Record<string, string> = {
    ...w.env,
    ...(c.portEnv ? { [c.portEnv]: String(port) } : {}),
    PORT: String(port),
    HOST: '127.0.0.1',
    EE_WORKLOAD: w.name,
    EE_STATE_DIR: `/var/lib/ee-state/${w.name}`,
    EE_API_URL,
    // DynamicUser has no home: apps that keep data under ~ get their persistent state dir.
    HOME: `/var/lib/ee-state/${w.name}`,
    ...start.runtimeEnv,
  }
  const needsPostgres = c.services.includes('postgres')
  const lines = [
    '# Generated by ee from the company repo. Do not edit: the next reconcile overwrites it.',
    '[Unit]',
    `Description=eigenEnterprise workload ${w.name} (slot ${slot})`,
    'After=network-online.target' + (needsPostgres ? ' postgresql.service' : ''),
    'Wants=network-online.target',
    ...(needsPostgres ? ['Requires=postgresql.service'] : []),
    '',
    '[Service]',
    'Type=simple',
    // One dynamic user per WORKLOAD, not per slot: systemd shares the UID between
    // units naming the same User=, so both blue-green slots own the StateDirectory
    // (a per-slot user would re-chown it under the slot still serving).
    `User=ee-${w.name}`,
    `WorkingDirectory=${releaseDir}`,
    // npm's cache in the private /tmp (the runtime is on PATH via env).
    ...(start.npm
      ? [envAssignment('npm_config_cache', '/tmp/npm-cache'), envAssignment('npm_config_update_notifier', 'false')]
      : []),
    ...Object.entries(env)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => envAssignment(k, v)),
    // Secrets: rendered root-only by ee, read by systemd before privileges drop.
    `EnvironmentFile=${PATHS.envDir}/${w.name}-${slot}.env`,
    ...c.preStart.map((step) => `ExecStartPre=${start.exec(step)}`),
    `ExecStart=${start.exec(c.start!)}`,
    'Restart=on-failure',
    'RestartSec=2',
    'TimeoutStopSec=20',
    `StateDirectory=ee-state/${w.name}`,
    `ReadOnlyPaths=${releaseDir}`,
    `MemoryMax=${w.resources.memoryMb}M`,
    `CPUQuota=${w.resources.cpuPercent}%`,
    `SocketBindAllow=tcp:${port}`,
    // Host ports (system tier, allow-listed by the spec): the only binds beyond the loopback slot port.
    ...(w.ports ?? []).map((p) => `SocketBindAllow=${p.proto}:${p.port}`),
    'SocketBindDeny=any',
    ...(input.supplementaryGroups && input.supplementaryGroups.length > 0
      ? [`SupplementaryGroups=${input.supplementaryGroups.join(' ')}`, `ReadWritePaths=${PATHS.controlSocketDir}`]
      : []),
    ...hardeningFor(w),
    '',
    '[Install]',
    'WantedBy=multi-user.target',
    '',
  ]
  return lines.join('\n')
}
