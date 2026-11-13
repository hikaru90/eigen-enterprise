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
      webServer: (c.webServer ?? []).map((s) => ({ command: s.command, url: s.url, reuseExistingServer: s.reuseExistingServer, env: s.env && { ORIGIN: s.env.ORIGIN, LIVEKIT_CONFIG: s.env.LIVEKIT_CONFIG, LIVEKIT_URL: s.env.LIVEKIT_URL, LIVEKIT_API_URL: s.env.LIVEKIT_API_URL, LIVEKIT_API_KEY: s.env.LIVEKIT_API_KEY, LIVEKIT_API_SECRET: s.env.LIVEKIT_API_SECRET, CONTRIBUTE_HUB_URL: s.env.CONTRIBUTE_HUB_URL } })),
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
// Browser e2e runs its own throwaway harness (Vite + mock gateway + mock Contribute hub + livekit-server), started and
// stopped by Playwright — never an already-running server.
describe('no dev server', () => {
  it('has no `npm run dev` script', async () => {
    const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
    expect(pkg.scripts.dev).toBeUndefined()
  })

  for (const ci of ['', '1']) {
    it(`e2e starts its own harness and never reuses a running server (CI=${ci || 'unset'})`, async () => {
      const config = await readPlaywrightConfig({ CI: ci })
      expect(config.webServer.length).toBe(4)
      for (const server of config.webServer) expect(server.reuseExistingServer).toBe(false)
      const app = config.webServer.find((s) => s.command.includes('vite'))
      expect(app?.command).toContain('--strictPort')
      expect(app?.env?.ORIGIN).toBe(config.baseUrl)
      expect(config.baseUrl).toBe('http://localhost:4173')
      // Calls: a throwaway livekit-server whose signed webhook reaches the Vite harness,
      // with the same key pair the console is given.
      const livekit = config.webServer.find((s) => s.command.includes('livekit-server'))
      const lk = JSON.parse(livekit?.env?.LIVEKIT_CONFIG ?? '{}')
      expect(lk.webhook.urls).toEqual([`${config.baseUrl}/api/calls/livekit`])
      expect(lk.keys).toEqual({ [app!.env!.LIVEKIT_API_KEY]: app!.env!.LIVEKIT_API_SECRET })
      expect(lk.webhook.api_key).toBe(app!.env!.LIVEKIT_API_KEY)
      expect(app!.env!.LIVEKIT_API_SECRET.length).toBeGreaterThanOrEqual(32)
      expect(app?.env?.LIVEKIT_URL).toBe(`ws://127.0.0.1:${lk.port}`)
      expect(app?.env?.LIVEKIT_API_URL).toBe(`http://127.0.0.1:${lk.port}`)
      expect(livekit?.url).toBe(`http://127.0.0.1:${lk.port}/`)
      // Media on loopback only, never the box's published 7881/7882.
      expect(lk.rtc).toMatchObject({ node_ip: '127.0.0.1', use_external_ip: false })
      expect([lk.rtc.tcp_port, lk.rtc.udp_port]).not.toContain(7881)
      expect([lk.rtc.tcp_port, lk.rtc.udp_port]).not.toContain(7882)
      // Contribute phone-home: the app shares with the throwaway mock hub, never a real central board.
      const hub = config.webServer.find((s) => s.command.includes('scripts/mock-hub.ts'))
      expect(hub?.url).toBe(`${app?.env?.CONTRIBUTE_HUB_URL}/__mock-hub/requests`)
      expect(app?.env?.CONTRIBUTE_HUB_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    }, 30_000)
  }
})
