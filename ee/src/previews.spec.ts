import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { PATHS } from './paths.ts'
import { UnsafeTarballError } from './preview-tar.ts'
import { PreviewBox } from './preview-test-box.ts'
import { PreviewError, PreviewService, type PreviewView } from './previews.ts'

const ID = 'pv3f9a0c12be47'
const OTHER = 'pv000000000001'
const KERNEL_DIR = `${PATHS.osState}/previews`
const NODE = `${PATHS.runtimes}/node-22/bin`
const sha = (s: string) => createHash('sha256').update(s).digest('hex')

const VITE = {
  'package.json': JSON.stringify({ scripts: { dev: 'vite', build: 'vite build' } }),
  'package-lock.json': '{}',
  'index.html': '<h1>hi</h1>',
}

type Events = Array<{ type: string; message: string; data: Record<string, unknown> }>

function setup(opts: { consoleHost?: string } = {}) {
  const box = new PreviewBox()
  const events: Events = []
  let edgeChanges = 0
  const scans: string[] = []
  let scanError: Error | null = null
  const svc = new PreviewService({
    sys: box,
    consoleHost: async () => opts.consoleHost ?? 'os.example.com',
    emit: async (type, message, data) => void events.push({ type, message, data }),
    edgeChanged: async () => void edgeChanges++,
    scan: async (p) => {
      scans.push(p)
      if (scanError) throw scanError
      return { files: 3, bytes: 100 }
    },
  })
  let n = 0
  /** The kernel writes a snapshot of these files into its hand-off dir. */
  const handOff = (files: Record<string, string>, id = ID) => {
    const content = `TARBALL-${++n}`
    box.archives.set(content, files)
    const tarball = `${KERNEL_DIR}/${id}-${1763600000000 + n}.tar.gz`
    box.files.set(tarball, content)
    return { id, tarball, sha256: sha(content), folderName: 'my-vite-app', author: 'user:alex' }
  }
  return {
    box,
    svc,
    events,
    handOff,
    scans,
    edgeChanges: () => edgeChanges,
    failScan: (e: Error) => void (scanError = e),
  }
}

async function run(t: ReturnType<typeof setup>, input: ReturnType<ReturnType<typeof setup>['handOff']>): Promise<PreviewView> {
  const { done } = await t.svc.start(input)
  await done
  return t.svc.get(input.id)
}

const prop = (cmd: string[], name: string) => cmd.filter((a, i) => cmd[i - 1] === '-p' && a.startsWith(`${name}=`)).map((a) => a.slice(name.length + 1))
const envOf = (cmd: string[]) => cmd.filter((_, i) => cmd[i - 1] === '-E')

describe('previews: run a Drive web-app folder (plan/phase-drive-app-preview.md)', () => {
  it('answers installing at once, with the preview host and url', async () => {
    const t = setup()
    const { preview, done } = await t.svc.start(t.handOff(VITE))
    expect(preview).toMatchObject({
      id: ID,
      folderName: 'my-vite-app',
      state: 'installing',
      host: `${ID}.preview.os.example.com`,
      url: `https://${ID}.preview.os.example.com/`,
      script: null,
      startedAt: '2026-11-20T10:00:00.000Z',
      lastSeenAt: '2026-11-20T10:00:00.000Z',
      error: null,
    })
    await done
  })

  it('takes the snapshot into its own dir: checked copy, scanned before unpacking, kernel copy deleted', async () => {
    const t = setup()
    const input = t.handOff(VITE)
    await run(t, input)
    const own = `${PATHS.previews}/incoming/${input.tarball.split('/').at(-1)}`
    expect(t.box.ran('cp')).toEqual([['cp', '--no-dereference', '--', input.tarball, own]])
    expect(t.scans).toEqual([own])
    expect(t.box.files.has(input.tarball)).toBe(false)
    expect(t.box.files.has(own)).toBe(false)
    const tar = t.box.ran('tar')[0]!
    expect(tar).toEqual(['tar', '-xzf', own, '-C', expect.stringMatching(new RegExp(`^${PATHS.previews}/${ID}-\\d+$`)), '--no-same-owner', '--no-same-permissions'])
    expect(t.box.commands.findIndex((c) => c[0] === 'tar')).toBeGreaterThan(t.box.commands.findIndex((c) => c[0] === 'cp'))
  })

  it('installs with npm ci in a capped unit as ee-preview, then runs `npm run dev` sandboxed with only PORT, HOST, NODE_ENV and Node 22', async () => {
    const t = setup()
    const view = await run(t, t.handOff(VITE))
    expect(view.state).toBe('running')
    expect(view.script).toBe('dev')
    const [install, dev] = t.box.ran('systemd-run') as [string[], string[]]
    const dir = t.box.ran('tar')[0]![4]!
    expect(t.box.ran('chown')).toContainEqual(['chown', '-R', 'ee-preview:ee-preview', dir])

    expect(install).toContain('--wait')
    expect(install).toContain(`--unit=ee-preview-install-${ID}`)
    expect(prop(install, 'User')).toEqual(['ee-preview'])
    expect(prop(install, 'MemoryMax')).toEqual(['1024M'])
    expect(prop(install, 'RuntimeMaxSec')).toEqual(['900'])
    expect(prop(install, 'NoNewPrivileges')).toEqual(['yes'])
    expect(prop(install, 'ReadWritePaths')).toEqual([`${dir} ${PATHS.previewCache}`])
    expect(install).toContain(`--working-directory=${dir}`)
    expect(envOf(install)).toContain(`npm_config_cache=${PATHS.previewCache}/npm`)
    expect(install.slice(-2)).toEqual([`${NODE}/npm`, 'ci'])

    expect(dev).not.toContain('--wait')
    expect(dev).toContain(`--unit=ee-preview-${ID}`)
    expect(prop(dev, 'User')).toEqual(['ee-preview'])
    expect(prop(dev, 'Group')).toEqual(['ee-preview'])
    expect(prop(dev, 'NoNewPrivileges')).toEqual(['yes'])
    expect(prop(dev, 'ProtectSystem')).toEqual(['strict'])
    expect(prop(dev, 'ProtectHome')).toEqual(['yes'])
    expect(prop(dev, 'PrivateTmp')).toEqual(['yes'])
    expect(prop(dev, 'PrivateDevices')).toEqual(['yes'])
    expect(prop(dev, 'ReadWritePaths')).toEqual([dir])
    expect(prop(dev, 'MemoryMax')).toEqual(['1024M'])
    expect(prop(dev, 'InaccessiblePaths')[0]).toContain(PATHS.osState.replace(/\/os$/, ''))
    expect(prop(dev, 'InaccessiblePaths')[0]).toContain('/etc/ee')
    expect(dev).toContain(`--working-directory=${dir}`)
    expect(envOf(dev).sort()).toEqual([`HOME=/tmp`, 'HOST=127.0.0.1', 'NODE_ENV=development', `PATH=${NODE}:/usr/bin:/bin`, 'PORT=41000'].sort())
    expect(dev.slice(-3)).toEqual([`${NODE}/npm`, 'run', 'dev'])
  })

  it('finds the port the unit listens on and routes the host there (Caddy, in memory)', async () => {
    const t = setup()
    expect(t.svc.routes()).toEqual([])
    const { done } = await t.svc.start(t.handOff(VITE))
    expect(t.svc.routes()).toEqual([{ host: `${ID}.preview.os.example.com`, upstream: null }])
    await done
    expect(t.svc.routes()).toEqual([{ host: `${ID}.preview.os.example.com`, upstream: { dial: '127.0.0.1:5173', port: 5173 } }])
    expect(t.edgeChanges()).toBeGreaterThanOrEqual(2)
    expect(t.box.ran('ss').every((c) => c.join(' ').startsWith('ss -ltn'))).toBe(true)
  })

  it('journals started and running, with the author', async () => {
    const t = setup()
    await run(t, t.handOff(VITE))
    expect(t.events.map((e) => e.type)).toEqual(['preview.started', 'preview.running'])
    for (const e of t.events) expect(e.data).toMatchObject({ id: ID, author: 'user:alex' })
    expect(t.events[1]!.message).toContain(`${ID}.preview.os.example.com`)
  })

  it('falls back to the start script', async () => {
    const t = setup()
    const view = await run(t, t.handOff({ ...VITE, 'package.json': JSON.stringify({ scripts: { start: 'node server.js' } }) }))
    expect(view.script).toBe('start')
    expect(t.box.ran('systemd-run')[1]!.slice(-3)).toEqual([`${NODE}/npm`, 'run', 'start'])
  })

  it.each([
    ['pnpm-lock.yaml', ['corepack', 'pnpm', 'install', '--frozen-lockfile']],
    ['yarn.lock', ['corepack', 'yarn', 'install', '--immutable']],
  ])('installs through corepack when the lockfile is %s', async (lockfile, cmd) => {
    const t = setup()
    const { 'package-lock.json': _npm, ...rest } = VITE
    await run(t, t.handOff({ ...rest, [lockfile]: 'lock' }))
    const install = t.box.ran('systemd-run')[0]!
    expect(install.slice(-cmd.length)).toEqual([`${NODE}/${cmd[0]}`, ...cmd.slice(1)])
    expect(envOf(install)).toContain(`COREPACK_HOME=${PATHS.previewCache}/corepack`)
  })

  it.each([
    [{ 'package.json': JSON.stringify({ scripts: { dev: 'vite' } }) }, 'add a lockfile (package-lock.json, pnpm-lock.yaml or yarn.lock)'],
    [{ 'package.json': JSON.stringify({ scripts: { build: 'vite build' } }), 'package-lock.json': '{}' }, 'package.json has no dev or start script'],
    [{ 'index.html': '<h1/>' }, 'the folder has no package.json at its top level'],
    [{ 'package.json': '{ nope', 'package-lock.json': '{}' }, 'package.json is not valid JSON'],
  ])('fails loud before installing: %j', async (files, error) => {
    const t = setup()
    const view = await run(t, t.handOff(files))
    expect(view.state).toBe('failed')
    expect(view.error).toBe(error)
    expect(t.box.ran('systemd-run')).toEqual([])
    expect(t.svc.routes()).toEqual([])
    expect(t.events.map((e) => e.type)).toEqual(['preview.started', 'preview.failed'])
    expect(t.events[1]!.message).toContain(error)
  })

  it('a failed install fails the preview with its log', async () => {
    const t = setup()
    t.box.installExit = 1
    t.box.journals.set(`ee-preview-install-${ID}`, ['npm ERR! code ERESOLVE', 'npm ERR! could not resolve'])
    const view = await run(t, t.handOff(VITE))
    expect(view.state).toBe('failed')
    expect(view.error).toBe('installing dependencies failed (exit 1); see the log')
    expect(view.log).toEqual(['$ npm ci', 'npm ERR! code ERESOLVE', 'npm ERR! could not resolve'])
    expect(t.box.ran('systemd-run')).toHaveLength(1)
  })

  it('a dev server that never listens fails after 5 minutes, and its unit is stopped', async () => {
    const t = setup()
    t.box.devServer = null
    t.box.journals.set(`ee-preview-${ID}`, ['> vite', 'waiting…'])
    const start = t.box.clock
    const view = await run(t, t.handOff(VITE))
    expect(view.state).toBe('failed')
    expect(view.error).toBe('the dev server did not listen on a port within 5 minutes')
    expect(t.box.clock - start).toBeGreaterThanOrEqual(300_000)
    expect(t.box.units.get(`ee-preview-${ID}`)).not.toBe('active')
    expect(view.log).toEqual(['$ npm ci', '$ npm run dev', '> vite', 'waiting…'])
    expect(t.svc.routes()).toEqual([])
  })

  it('a dev server that exits before listening fails at once', async () => {
    const t = setup()
    t.box.devServer = { afterMs: 2000, exit: true }
    const start = t.box.clock
    const view = await run(t, t.handOff(VITE))
    expect(view.state).toBe('failed')
    expect(view.error).toBe('the dev server exited before it listened on a port')
    expect(t.box.clock - start).toBeLessThan(10_000)
  })

  it('port watch: only the unit cgroup counts; 127.0.0.1 is preferred; an IPv6-only listener is dialed as [::1]', async () => {
    const t = setup()
    t.box.usedPorts = [5432]
    t.box.devServer = { afterMs: 1000, listen: ['[::1]:5174', '127.0.0.1:24678'] }
    await run(t, t.handOff(VITE))
    expect(t.svc.routes()[0]!.upstream).toEqual({ dial: '127.0.0.1:24678', port: 24678 })

    const u = setup()
    u.box.devServer = { afterMs: 1000, listen: ['[::1]:5173'] }
    await run(u, u.handOff(VITE))
    expect(u.svc.routes()[0]!.upstream).toEqual({ dial: '[::1]:5173', port: 5173 })
  })

  it('the port it hands the app (PORT) is a free one in 41000–41999', async () => {
    const t = setup()
    t.box.usedPorts = [41000, 41001]
    await run(t, t.handOff(VITE))
    expect(envOf(t.box.ran('systemd-run')[1]!)).toContain('PORT=41002')
  })

  it('the log is the last 200 lines of install and dev server output', async () => {
    const t = setup()
    t.box.journals.set(`ee-preview-install-${ID}`, Array.from({ length: 150 }, (_, i) => `install ${i}`))
    t.box.journals.set(`ee-preview-${ID}`, Array.from({ length: 100 }, (_, i) => `dev ${i}`))
    const view = await run(t, t.handOff(VITE))
    expect(view.log).toHaveLength(200)
    expect(view.log.at(-1)).toBe('dev 99')
    expect(view.log).toContain('$ npm run dev')
    expect(view.log[0]).toBe('install 51')
    const jc = t.box.ran('journalctl')[0]!
    expect(jc).toEqual(expect.arrayContaining(['-n', '200', '--no-pager', '-o', 'cat']))
  })
})

describe('previews: the hand-off is checked before anything runs', () => {
  it.each([
    ['/tmp/x.tar.gz'],
    [`${KERNEL_DIR}/../previews/${ID}-1.tar.gz`],
    [`${KERNEL_DIR}/sub/${ID}-1.tar.gz`],
    [`${KERNEL_DIR}/${OTHER}-1.tar.gz`],
    [`${KERNEL_DIR}/${ID}-1.tgz`],
  ])('refuses a tarball at %s and touches nothing', async (tarball) => {
    const t = setup()
    const input = { ...t.handOff(VITE), tarball }
    t.box.files.set(tarball, 'x')
    await expect(t.svc.start(input)).rejects.toMatchObject({ status: 422, type: 'urn:ee:preview_rejected' })
    expect(t.box.files.has(tarball)).toBe(true)
    expect(t.box.commands).toEqual([])
  })

  it('refuses a checksum mismatch and deletes both copies', async () => {
    const t = setup()
    const input = t.handOff(VITE)
    await expect(t.svc.start({ ...input, sha256: 'f'.repeat(64) })).rejects.toMatchObject({ status: 422, message: expect.stringMatching(/checksum/) })
    expect(t.box.files.has(input.tarball)).toBe(false)
    expect([...t.box.files.keys()].some((k) => k.startsWith(`${PATHS.previews}/incoming/`))).toBe(false)
    expect(t.box.ran('tar')).toEqual([])
    await expect(t.svc.get(ID)).rejects.toMatchObject({ status: 404 })
  })

  it('refuses an unsafe tarball (symlinks, devices, paths outside) before unpacking it', async () => {
    const t = setup()
    t.failScan(new UnsafeTarballError('"passwd" is a symbolic link; a snapshot holds only regular files and directories'))
    const input = t.handOff(VITE)
    await expect(t.svc.start(input)).rejects.toMatchObject({ status: 422, message: expect.stringMatching(/symbolic link/) })
    expect(t.box.ran('tar')).toEqual([])
    expect(t.box.files.has(input.tarball)).toBe(false)
  })

  it('refuses a hand-off that is itself a symlink', async () => {
    const t = setup()
    const input = t.handOff(VITE)
    t.box.symlinks.add(input.tarball)
    await expect(t.svc.start(input)).rejects.toMatchObject({ status: 422, message: expect.stringMatching(/regular file/) })
    expect(t.box.ran('cp')).toEqual([])
  })

  it('refuses a missing tarball', async () => {
    const t = setup()
    const input = t.handOff(VITE)
    t.box.files.delete(input.tarball)
    await expect(t.svc.start(input)).rejects.toMatchObject({ status: 422, message: expect.stringMatching(/no snapshot/) })
  })

  it('refuses invalid input (id shape, sha256 shape, extra keys)', async () => {
    const t = setup()
    const input = t.handOff(VITE)
    for (const bad of [{ ...input, id: 'pvXYZ' }, { ...input, sha256: 'abc' }, { ...input, extra: 1 }, { ...input, author: '' }]) {
      await expect(t.svc.start(bad)).rejects.toMatchObject({ status: 400, type: 'urn:ee:invalid_input' })
    }
  })

  it('refuses while the box has no console host', async () => {
    const t = setup({ consoleHost: 'unset' })
    await expect(t.svc.start(t.handOff(VITE))).rejects.toMatchObject({ status: 409, type: 'urn:ee:preview_unavailable' })
  })
})

describe('previews: one at a time, restart, stop, idle, ee start', () => {
  it('another preview while one is active is busy (409) with the running one', async () => {
    const t = setup()
    await run(t, t.handOff(VITE))
    const err = (await t.svc.start(t.handOff(VITE, OTHER)).catch((e: unknown) => e)) as PreviewError
    expect(err).toBeInstanceOf(PreviewError)
    expect(err.status).toBe(409)
    expect(err.type).toBe('urn:ee:preview_busy')
    expect((err.extra as { running: PreviewView }).running).toMatchObject({ id: ID, state: 'running', folderName: 'my-vite-app' })
  })

  it('a failed or stopped preview does not block another one', async () => {
    const t = setup()
    await run(t, t.handOff({ 'package.json': '{}' }))
    expect((await run(t, t.handOff(VITE, OTHER))).state).toBe('running')
  })

  it('the same id restarts it: the old units stop, the new snapshot runs in a fresh dir', async () => {
    const t = setup()
    await run(t, t.handOff(VITE))
    const firstDir = t.box.ran('tar')[0]![4]!
    t.box.files.set(`${firstDir}/marker`, 'old')
    t.box.clock += 5000
    const view = await run(t, t.handOff({ ...VITE, 'index.html': '<h1>new</h1>' }))
    expect(view.state).toBe('running')
    const secondDir = t.box.ran('tar')[1]![4]!
    expect(secondDir).not.toBe(firstDir)
    expect(t.box.files.has(`${firstDir}/marker`)).toBe(false)
    expect(t.box.files.get(`${secondDir}/index.html`)).toBe('<h1>new</h1>')
    expect(t.box.ran('systemctl').some((c) => c[1] === 'stop' && c.includes(`ee-preview-${ID}.service`))).toBe(true)
    expect(t.events.map((e) => e.type)).toEqual(['preview.started', 'preview.running', 'preview.stopped', 'preview.started', 'preview.running'])
  })

  it('restarting while it installs cancels the first run (it never comes up)', async () => {
    const t = setup()
    let restarted: Promise<void> | null = null
    t.box.duringInstall = async () => {
      t.box.duringInstall = null
      restarted = t.svc.start(t.handOff(VITE)).then((r) => r.done)
      await new Promise((r) => setTimeout(r, 10))
    }
    const { done } = await t.svc.start(t.handOff(VITE))
    await done
    await restarted
    expect((await t.svc.get(ID)).state).toBe('running')
    expect(t.box.ran('systemd-run').filter((c) => c.includes(`--unit=ee-preview-${ID}`))).toHaveLength(1)
  })

  it('DELETE stops the unit, removes its files and route, and journals who stopped it', async () => {
    const t = setup()
    await run(t, t.handOff(VITE))
    const dir = t.box.ran('tar')[0]![4]!
    const view = await t.svc.stop(ID, { author: 'user:alex' })
    expect(view).toMatchObject({ state: 'stopped', error: null })
    expect(t.box.units.get(`ee-preview-${ID}`)).toBe('inactive')
    expect(await t.box.exists(dir)).toBe(false)
    expect(t.svc.routes()).toEqual([])
    expect(t.events.at(-1)).toMatchObject({ type: 'preview.stopped', data: { id: ID, author: 'user:alex' } })
    await expect(t.svc.stop('pv999999999999', { author: 'user:alex' })).rejects.toMatchObject({ status: 404 })
  })

  it('stopping while it installs ends the install; the preview stays stopped', async () => {
    const t = setup()
    t.box.duringInstall = async () => void (await t.svc.stop(ID, { author: 'user:alex' }))
    const { done } = await t.svc.start(t.handOff(VITE))
    await done
    expect((await t.svc.get(ID)).state).toBe('stopped')
    expect(t.box.ran('systemd-run')).toHaveLength(1)
    expect(t.events.map((e) => e.type)).toEqual(['preview.started', 'preview.stopped'])
  })

  it('stops after 30 minutes without /seen, checked by the minute sweep', async () => {
    const t = setup()
    await run(t, t.handOff(VITE))
    t.box.clock += 29 * 60_000
    await t.svc.seen(ID)
    t.box.clock += 29 * 60_000
    await t.svc.sweep()
    expect((await t.svc.get(ID)).state).toBe('running')
    t.box.clock += 60_000
    await t.svc.sweep()
    const view = await t.svc.get(ID)
    expect(view).toMatchObject({ state: 'stopped', error: 'idle for 30 minutes' })
    expect(t.events.at(-1)).toMatchObject({ type: 'preview.stopped' })
    expect(t.events.at(-1)!.data['author']).toBeUndefined()
  })

  it('seen updates lastSeenAt; unknown ids are 404', async () => {
    const t = setup()
    await run(t, t.handOff(VITE))
    t.box.clock += 60_000
    expect((await t.svc.seen(ID)).lastSeenAt).toBe(new Date(t.box.clock).toISOString())
    await expect(t.svc.seen(OTHER)).rejects.toMatchObject({ status: 404, type: 'urn:ee:preview_not_found' })
  })

  it('ee start stops every leftover preview unit and wipes the preview dirs', async () => {
    const t = setup()
    t.box.leftovers = [`ee-preview-${ID}.service`, `ee-preview-install-${OTHER}.service`, 'ee-os-a.service']
    t.box.files.set(`${PATHS.previews}/${ID}-1/package.json`, '{}')
    await t.svc.wipe()
    const stops = t.box.ran('systemctl').filter((c) => c[1] === 'stop')
    expect(stops).toEqual([['systemctl', 'stop', `ee-preview-${ID}.service`, `ee-preview-install-${OTHER}.service`]])
    expect(await t.box.exists(PATHS.previews)).toBe(false)
    expect(await t.svc.list()).toEqual([])
  })

  it('lists every preview it knows, newest first', async () => {
    const t = setup()
    await run(t, t.handOff({ 'package.json': '{}' }))
    t.box.clock += 1000
    await run(t, t.handOff(VITE, OTHER))
    expect((await t.svc.list()).map((p) => [p.id, p.state])).toEqual([
      [OTHER, 'running'],
      [ID, 'failed'],
    ])
  })
})
