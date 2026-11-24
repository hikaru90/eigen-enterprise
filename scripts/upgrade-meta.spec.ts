import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { MIN_UPGRADE_FROM, upgradeMeta } from './upgrade-meta.mjs'
import { compareVersions } from './downgrade-floor.mjs'
import { META_REQUIRED_SINCE, parseMeta } from '../ee/src/release-meta.ts'

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8')
const RELEASE = 'eigenenterprise-0.5.40-aaaaaaaaaaaa'

describe('UPGRADE.json (the signed upgrade metadata ee checks on the box)', () => {
  it('carries the floor, minFrom and the capabilities ee.json declares', () => {
    const eeJson = JSON.parse(read('../ee.json'))
    expect(upgradeMeta({ release: RELEASE, downgradeFloor: '0.5.39', eeJson })).toEqual({
      release: RELEASE,
      downgradeFloor: '0.5.39',
      minFrom: MIN_UPGRADE_FROM,
      capabilities: eeJson.capabilities,
    })
  })

  it('is what ee reads (the box parses the build output)', () => {
    const raw = JSON.stringify(upgradeMeta({ release: RELEASE, downgradeFloor: '0.5.39', eeJson: { capabilities: ['chromium'] } }))
    expect(parseMeta(raw, RELEASE)).toMatchObject({ downgradeFloor: '0.5.39', minFrom: MIN_UPGRADE_FROM, capabilities: ['chromium'], legacy: false })
  })

  it('refuses a name or floor that is not one', () => {
    expect(() => upgradeMeta({ release: '0.5.40', downgradeFloor: '0.5.39', eeJson: {} })).toThrow(/not a release name/)
    expect(() => upgradeMeta({ release: RELEASE, downgradeFloor: 'latest', eeJson: {} })).toThrow(/not a version/)
  })

  it('ee requires it from the first release that writes it (0.5.40), and this build is one of them', () => {
    const version = JSON.parse(read('../package.json')).version as string
    // Pinned: moving the requirement later would let a box accept an unsigned release that should carry one.
    expect(META_REQUIRED_SINCE).toBe('0.5.40')
    expect(compareVersions(META_REQUIRED_SINCE, version)).toBeLessThanOrEqual(0)
  })

  it('release.sh writes it and lists it in SHA256SUMS; the workflow publishes it', () => {
    const sh = read('./release.sh')
    expect(sh).toMatch(/node "\$ROOT\/scripts\/upgrade-meta\.mjs" "eigenenterprise-\$\{VERSION\}-\$\{SHA\}" "\$\(cat "\$OUT\/DOWNGRADE_FLOOR"\)" > "\$OUT\/UPGRADE\.json"/)
    expect(sh).toMatch(/shasum -a 256 LATEST NOTES\.md DOWNGRADE_FLOOR UPGRADE\.json install\.sh/)
    const yml = read('../.github/workflows/release.yml')
    expect(yml).toContain('dist/release/UPGRADE.json')
    expect(yml).toMatch(/for f in LATEST NOTES\.md DOWNGRADE_FLOOR UPGRADE\.json install\.sh/)
    expect(yml).toMatch(/cp built\/release-amd64\/\{LATEST,NOTES\.md,DOWNGRADE_FLOOR,UPGRADE\.json,install\.sh/)
  })
})
