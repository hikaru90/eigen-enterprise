import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const moduleDir = path.dirname(fileURLToPath(import.meta.url))

/**
 * Colocated test config for modules/chat-gateway.
 *
 * The root vitest.config.ts include patterns do not cover `modules/**`, and its
 * globalTeardown imports the app DB pool (requires DATABASE_URL). Pure unit
 * specs for this module therefore run through this lean config:
 *
 *   npx vitest run --config modules/chat-gateway/vitest.config.ts
 *
 * No network, no DB — collaborators are injected fakes.
 */
export default defineConfig({
  root: path.resolve(moduleDir, '../..'),
  resolve: {
    alias: {
      $lib: path.resolve(moduleDir, '../../src/lib'),
    },
  },
  test: {
    environment: 'node',
    include: ['modules/chat-gateway/**/*.spec.ts'],
  },
})
