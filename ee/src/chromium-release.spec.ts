import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { CHROMIUM_EXECUTABLE } from './capabilities.ts'

/**
 * The headless Chromium capability (brand site capture, plan/phase-substrate.md §3.3).
 * scripts/release.sh fetches Playwright's chrome-headless-shell build, checks it
 * against a pinned sha256 and packs it; ee/install.sh installs it under
 * /opt/ee/capabilities/chromium with its system libraries. These checks keep the
 * pin real and in step with the playwright-core the os release drives it with
 * (Playwright speaks only to the browser revision it was built for).
 */

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8')
const releaseSh = read('../../scripts/release.sh')
const installSh = read('../install.sh')
const workflow = read('../../.github/workflows/release.yml')
const value = (text: string, name: string) => new RegExp(`^${name}="?([^"\\s]+)"?$`, 'm').exec(text)?.[1]

const browsers = JSON.parse(read('../../node_modules/playwright-core/browsers.json')) as {
  browsers: { name: string; revision: string; browserVersion: string }[]
}
const shell = browsers.browsers.find((b) => b.name === 'chromium-headless-shell')!
const lock = JSON.parse(read('../../package-lock.json')) as { packages: Record<string, { version: string }> }

describe('the pinned headless Chromium', () => {
  it('release.sh pins the revision and version the installed playwright-core drives', () => {
    expect(value(releaseSh, 'CHROMIUM_REVISION')).toBe(shell.revision)
    expect(value(releaseSh, 'CHROMIUM_VERSION')).toBe(shell.browserVersion)
    expect(value(releaseSh, 'PLAYWRIGHT_CORE_VERSION')).toBe(lock.packages['node_modules/playwright-core']!.version)
  })

  it('release.sh pins the sha256 of each linux build', () => {
    expect(value(releaseSh, 'CHROMIUM_SHA256_amd64')).toBe('cf779cd5486f3fc5a18bea4ac606026a1667ae16efaee15af51bd3ad3ae01092')
    expect(value(releaseSh, 'CHROMIUM_SHA256_arm64')).toBe('6db7041d8a273093b8f2c7a7338766c6d12abb06cd0253fc91feebb71ecd4635')
  })

  it('release.sh verifies the download against the pin and lists the pack in SHA256SUMS', () => {
    expect(releaseSh).toMatch(/\$\{CHROMIUM_SHA256\}\s+upstream\.zip' \| sha256sum -c/)
    expect(releaseSh).toMatch(/SHA256SUMS[^\n]*"\$CHROMIUM_NAME\.tar\.gz"|"\$CHROMIUM_NAME\.tar\.gz"[^\n]*> SHA256SUMS/)
  })

  it('install.sh installs the same revision, checks it is signed and that every library resolves', () => {
    expect(value(installSh, 'CHROMIUM_REVISION')).toBe(value(releaseSh, 'CHROMIUM_REVISION'))
    expect(installSh).toMatch(/signed "\$WORK\/\$CHROMIUM" "\$CHROMIUM"/)
    expect(installSh).toMatch(/install-deps chromium-headless-shell/)
    expect(installSh).toMatch(/ldd /)
  })

  it('install.sh puts the executable where ee points the workloads', () => {
    expect(CHROMIUM_EXECUTABLE).toBe('/opt/ee/capabilities/chromium/chrome-headless-shell')
    expect(installSh).toContain('CAPABILITY="/opt/ee/capabilities/chromium"')
  })

  it('the release workflow publishes the packs for both CPUs', () => {
    expect(workflow).toContain('dist/release/chromium-headless-shell-*.tar.gz')
    expect(workflow).toContain('cp built/release-*/chromium-headless-shell-*.tar.gz* out/')
  })
})
