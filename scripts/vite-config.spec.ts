import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const exec = promisify(execFile)
const root = process.cwd()

async function readConfig(file: string) {
  const script = `
    import { loadConfigFromFile } from 'vite';
    const result = await loadConfigFromFile({ command: 'serve', mode: 'development' }, ${JSON.stringify(file)});
    console.log(JSON.stringify({ cacheDir: result.config.cacheDir, strictPort: result.config.server?.strictPort, managedServers: result.config.webServer?.length ?? 0, baseUrl: result.config.use?.baseURL }));
  `
  const { stdout } = await exec(process.execPath, ['--input-type=module', '--eval', script], {
    cwd: root,
    env: { ...process.env, CI: '', E2E_MANAGED_SERVERS: '' },
    timeout: 30_000,
  })
  return JSON.parse(stdout.trim()) as {
    cacheDir?: string
    strictPort?: boolean
    managedServers: number
    baseUrl?: string
  }
}

describe('local Vite process isolation', () => {
  it('refuses to choose another port for the owner’s dev server', async () => {
    expect((await readConfig('vite.config.ts')).strictPort).toBe(true)
  })

  it('uses the owner’s server without starting local test services', async () => {
    const config = await readConfig('playwright.config.ts')
    expect(config.managedServers).toBe(0)
    expect(config.baseUrl).toBe('http://localhost:5174')
  })

  it('isolates optimizer caches between processes and browser tests', async () => {
    const first = await readConfig('vite.config.ts')
    const second = await readConfig('vite.config.ts')
    const browser = await readConfig('vitest.browser.config.ts')
    const caches = [first.cacheDir, second.cacheDir, browser.cacheDir]
    for (const cache of caches) {
      expect(typeof cache).toBe('string')
      expect(cache?.startsWith(path.join(root, '.svelte-kit', 'cache') + path.sep)).toBe(true)
    }
    expect(new Set(caches).size).toBe(3)
  })
})
