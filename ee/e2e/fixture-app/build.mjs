// The fixture's "build": writes dist/ — proves build steps run in ee's sandbox with write access to the release only.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
mkdirSync('dist', { recursive: true })
writeFileSync('dist/server.mjs', readFileSync('server.mjs', 'utf8').replace('__BUILT__', new Date().toISOString()))
