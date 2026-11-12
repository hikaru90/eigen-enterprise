/**
 * Types for the one Playwright registry call the capture layer makes
 * (capture.ts → defaultBrowserProbe). The subpath is in playwright-core's
 * package "exports" but ships no .d.ts.
 */
declare module 'playwright-core/lib/server/registry/index' {
  export const registry: {
    findExecutable(name: string): { executablePath(): string | undefined } | undefined
  }
}
