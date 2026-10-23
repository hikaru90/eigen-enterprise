import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const exec = promisify(execFile)
const root = process.cwd()

type WebServer = { command: string; url: string; reuseExistingServer?: boolean; env?: Record<string, string> }

async function readPlaywrightConfig(env: Record<string, string>) {
  const script = `
    import { loadConfigFromFile } from 'vite';
    const result = await loadConfigFromFile({ command: 'serve', mode: 'development' }, 'playwright.config.ts');
    const c = result.config;
    console.log(JSON.stringify({
      webServer: (c.webServer ?? []).map((s) => ({ command: s.command, url: s.url, reuseExistingServer: s.reuseExistingServer, env: { ORIGIN: s.env?.ORIGIN } })),
      baseUrl: c.use?.baseURL,
    }));
  `
  const { stdout } = await exec(process.execPath, ['--input-type=module', '--eval', script], {
    cwd: root,
    env: { ...process.env, ...env },
    timeout: 30_000,
  })
  return JSON.parse(stdout.trim()) as { webServer: WebServer[]; baseUrl?: string }
}

// No dev server (owner decision 2026-10-23): the ee box is the only install.
// Browser e2e runs its own throwaway harness (Vite + mock gateway), started and
// stopped by Playwright — never an already-running server.
describe('no dev server', () => {
  it('has no `npm run dev` script', async () => {
    const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
    expect(pkg.scripts.dev).toBeUndefined()
  })

  for (const ci of ['', '1']) {
    it(`e2e starts its own harness and never reuses a running server (CI=${ci || 'unset'})`, async () => {
      const config = await readPlaywrightConfig({ CI: ci })
      expect(config.webServer.length).toBe(2)
      for (const server of config.webServer) expect(server.reuseExistingServer).toBe(false)
      const app = config.webServer.find((s) => s.command.includes('vite'))
      expect(app?.command).toContain('--strictPort')
      expect(app?.env?.ORIGIN).toBe(config.baseUrl)
      expect(config.baseUrl).toBe('http://localhost:4173')
    }, 30_000)
  }
})
