import { describe, expect, it } from 'vitest'
import { OS_BODY_SIZE_LIMIT, bodyLimitBytes } from './body-limit.ts'

describe('os body size limit', () => {
  it('lets a full Drive upload through (100 MB default + multipart overhead)', () => {
    expect(bodyLimitBytes(OS_BODY_SIZE_LIMIT)).toBeGreaterThan(100 * 1024 * 1024)
  })

  it('parses the adapter-node formats and refuses anything else', () => {
    expect(bodyLimitBytes('512K')).toBe(512 * 1024)
    expect(bodyLimitBytes('2G')).toBe(2 * 1024 ** 3)
    expect(bodyLimitBytes('1000')).toBe(1000)
    expect(() => bodyLimitBytes('lots')).toThrow(/BODY_SIZE_LIMIT/)
  })
})
