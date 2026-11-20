import { describe, expect, it } from 'vitest'
import { webAppOf } from './web-app'

describe('webAppOf: a package.json file fact', () => {
  it('dev wins over start; a blank script does not count', () => {
    expect(webAppOf('{"scripts":{"dev":"vite","start":"node ."}}', [])).toEqual({ script: 'dev', lockfile: null })
    expect(webAppOf('{"scripts":{"dev":"  ","start":"node ."}}', [])).toEqual({ script: 'start', lockfile: null })
    expect(webAppOf('{"scripts":{"build":"vite build"}}', [])).toBeNull()
  })

  it('names the lockfile in the contract order', () => {
    expect(webAppOf('{"scripts":{"dev":"x"}}', ['yarn.lock', 'package-lock.json'])?.lockfile).toBe('package-lock.json')
    expect(webAppOf('{"scripts":{"dev":"x"}}', ['yarn.lock'])?.lockfile).toBe('yarn.lock')
  })

  it('text that is not a JSON object with scripts is no web app', () => {
    for (const t of ['', 'nope', '[]', 'null', '"x"', '{"scripts":[]}', '{"scripts":{"dev":1}}']) expect(webAppOf(t, [])).toBeNull()
  })
})
