import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises'
import { request } from 'node:http'
import { dirname } from 'node:path'
import { PATHS } from './paths.ts'

/**
 * Every side effect ee performs goes through this seam, so the reconciler is
 * tested against a fake and runs against the real box unchanged.
 */
export type RunResult = { code: number; stdout: string; stderr: string }

/** env is ADDED to ee's own environment for that one command. */
export type RunOpts = { cwd?: string; input?: string; timeoutMs?: number; env?: Record<string, string> }

export type System = {
  readFile(path: string): Promise<string | null>
  /** Durable atomic write (temp + fsync + rename + directory fsync) with the given mode. */
  writeFile(path: string, content: string, mode?: number): Promise<void>
  mkdirp(path: string, mode?: number): Promise<void>
  exists(path: string): Promise<boolean>
  remove(path: string): Promise<void>
  sha256File(path: string): Promise<string>
  run(cmd: string, args: string[], opts?: RunOpts): Promise<RunResult>
  /** GET http://127.0.0.1:<port><path>; true on 2xx/3xx before the deadline. */
  httpOk(port: number, path: string, timeoutMs: number): Promise<boolean>
  /** POST the full config to Caddy's admin socket (/load). Throws with Caddy's message on rejection. */
  caddyLoad(config: unknown): Promise<void>
  sleep(ms: number): Promise<void>
  now(): Date
}

/** The file operations a durable write needs (a seam so the order is tested). */
export type DurableFs = {
  mkdir(path: string, opts: { recursive: true }): Promise<unknown>
  open(
    path: string,
    flags: 'w' | 'r',
    mode?: number,
  ): Promise<{
    writeFile(data: string): Promise<void>
    chmod(mode: number): Promise<void>
    sync(): Promise<void>
    close(): Promise<void>
  }>
  rename(from: string, to: string): Promise<void>
}

const nodeFs: DurableFs = { mkdir, open: (p, flags, mode) => open(p, flags, mode), rename }

/**
 * Replace `path` so that after a crash or power cut it holds either the old
 * content or the new — never an empty or partial file. Temp file + rename
 * alone is not enough: without fsync the rename can reach the disk before the
 * data does (the box once came back with a 0-byte journal.json and ee
 * crash-looped on it). So: write the temp file, fsync it, rename, then fsync
 * the directory so the rename itself is durable.
 */
export async function durableWrite(path: string, content: string, mode: number, fs: DurableFs): Promise<void> {
  const dir = dirname(path)
  await fs.mkdir(dir, { recursive: true })
  const tmp = `${path}.ee-tmp-${process.pid}`
  const file = await fs.open(tmp, 'w', mode)
  try {
    await file.writeFile(content)
    await file.chmod(mode)
    await file.sync()
  } finally {
    await file.close()
  }
  await fs.rename(tmp, path)
  const d = await fs.open(dir, 'r')
  try {
    await d.sync()
  } finally {
    await d.close()
  }
}

export class RealSystem implements System {
  async readFile(path: string): Promise<string | null> {
    try {
      return await readFile(path, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw err
    }
  }

  async writeFile(path: string, content: string, mode = 0o644): Promise<void> {
    await durableWrite(path, content, mode, nodeFs)
  }

  async mkdirp(path: string, mode = 0o755): Promise<void> {
    await mkdir(path, { recursive: true, mode })
  }

  async exists(path: string): Promise<boolean> {
    try {
      await stat(path)
      return true
    } catch {
      return false
    }
  }

  async remove(path: string): Promise<void> {
    await rm(path, { recursive: true, force: true })
  }

  sha256File(path: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const hash = createHash('sha256')
      createReadStream(path)
        .on('data', (d) => hash.update(d))
        .on('error', reject)
        .on('end', () => resolve(hash.digest('hex')))
    })
  }

  run(cmd: string, args: string[], opts: RunOpts = {}): Promise<RunResult> {
    return new Promise((resolve) => {
      const child = execFile(
        cmd,
        args,
        { cwd: opts.cwd, env: opts.env ? { ...process.env, ...opts.env } : undefined, timeout: opts.timeoutMs ?? 600_000, maxBuffer: 64 * 1024 * 1024 },
        (err, stdout, stderr) => {
          const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0
          resolve({ code, stdout: String(stdout), stderr: String(stderr) })
        },
      )
      if (opts.input !== undefined) {
        child.stdin?.end(opts.input)
      }
    })
  }

  httpOk(port: number, path: string, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const req = request({ host: '127.0.0.1', port, path, method: 'GET', timeout: timeoutMs }, (res) => {
        res.resume()
        resolve((res.statusCode ?? 500) < 400)
      })
      req.on('error', () => resolve(false))
      req.on('timeout', () => {
        req.destroy()
        resolve(false)
      })
      req.end()
    })
  }

  caddyLoad(config: unknown): Promise<void> {
    const body = JSON.stringify(config)
    return new Promise((resolve, reject) => {
      const req = request(
        {
          socketPath: PATHS.caddyAdminSocket,
          path: '/load',
          method: 'POST',
          headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
        },
        (res) => {
          let text = ''
          res.on('data', (d) => (text += String(d)))
          res.on('end', () =>
            (res.statusCode ?? 500) < 300 ? resolve() : reject(new Error(`caddy rejected the config: ${text.trim()}`)),
          )
        },
      )
      req.on('error', (err) => reject(new Error(`caddy admin socket unreachable: ${err.message}`, { cause: err })))
      req.end(body)
    })
  }

  sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms))
  }

  now(): Date {
    return new Date()
  }
}

/** Throw with the command's stderr when it fails — never continue past a failed step. */
export async function mustRun(
  sys: System,
  cmd: string,
  args: string[],
  opts?: RunOpts,
): Promise<string> {
  const r = await sys.run(cmd, args, opts)
  if (r.code !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} failed (exit ${r.code}): ${(r.stderr || r.stdout).trim().slice(-2000)}`)
  }
  return r.stdout
}
