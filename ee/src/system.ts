import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import { dirname } from 'node:path'
import { PATHS } from './paths.ts'

/**
 * Every side effect ee performs goes through this seam, so the reconciler is
 * tested against a fake and runs against the real box unchanged.
 */
export type RunResult = { code: number; stdout: string; stderr: string }

export type System = {
  readFile(path: string): Promise<string | null>
  /** Atomic write (temp + rename) with the given mode. */
  writeFile(path: string, content: string, mode?: number): Promise<void>
  mkdirp(path: string, mode?: number): Promise<void>
  exists(path: string): Promise<boolean>
  remove(path: string): Promise<void>
  sha256File(path: string): Promise<string>
  run(cmd: string, args: string[], opts?: { cwd?: string; input?: string; timeoutMs?: number }): Promise<RunResult>
  /** GET http://127.0.0.1:<port><path>; true on 2xx/3xx before the deadline. */
  httpOk(port: number, path: string, timeoutMs: number): Promise<boolean>
  /** POST the full config to Caddy's admin socket (/load). Throws with Caddy's message on rejection. */
  caddyLoad(config: unknown): Promise<void>
  sleep(ms: number): Promise<void>
  now(): Date
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
    await mkdir(dirname(path), { recursive: true })
    const tmp = `${path}.ee-tmp-${process.pid}`
    await writeFile(tmp, content, { mode })
    await chmod(tmp, mode)
    await rename(tmp, path)
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

  run(cmd: string, args: string[], opts: { cwd?: string; input?: string; timeoutMs?: number } = {}): Promise<RunResult> {
    return new Promise((resolve) => {
      const child = execFile(
        cmd,
        args,
        { cwd: opts.cwd, timeout: opts.timeoutMs ?? 600_000, maxBuffer: 64 * 1024 * 1024 },
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
  opts?: { cwd?: string; input?: string; timeoutMs?: number },
): Promise<string> {
  const r = await sys.run(cmd, args, opts)
  if (r.code !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} failed (exit ${r.code}): ${(r.stderr || r.stdout).trim().slice(-2000)}`)
  }
  return r.stdout
}
