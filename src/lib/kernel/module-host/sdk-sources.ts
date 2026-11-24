import apacheLicense from '../../../../contracts/fixtures/modules/hello/LICENSE?raw'
import runtimeSource from '../../../../contracts/sdk/module-runtime.ts?raw'
import transportSource from '../../../../contracts/sdk/module-transport.ts?raw'
import testKernelSource from '../../../../contracts/sdk/test-kernel.ts?raw'

/**
 * The text a scaffolded module vendors (plan/phase-upgrades-u2.md §4.7, D9):
 * the SDK's three files and the Apache-2.0 LICENSE, read at build time
 * (Vite `?raw`) so the running app needs no source tree on disk.
 */
export const MODULE_SDK_SOURCES = {
  'module-runtime.ts': runtimeSource,
  'module-transport.ts': transportSource,
  'test-kernel.ts': testKernelSource,
} as const

export const APACHE_LICENSE_TEXT: string = apacheLicense
