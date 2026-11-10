import { realpathSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { paraglideVitePlugin } from '@inlang/paraglide-js'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { playwright } from '@vitest/browser-playwright'
import { defineConfig } from 'vitest/config'

const root = path.dirname(fileURLToPath(import.meta.url))

/**
 * Browser-mode Vitest for `*.svelte.spec.ts` (component tests).
 * Kept separate from `vitest.config.ts` / `test:unit` so node unit stays fast
 * and browser Playwright setup does not slow the merge-gate unit job.
 *
 * Uses `svelte()` (not full `sveltekit()` + PWA) so dep optimization stays
 * scoped to component specs. Specs that need `$app/*` mock those modules.
 *
 * Before running, `npm run test:components` applies
 * `scripts/patch-vitest-browser-iframeid.mjs` so paths containing `+` work.
 */
export default defineConfig({
  cacheDir: path.join(root, '.svelte-kit', 'cache', 'vitest-browser', String(process.pid)),
  // Git worktrees symlink node_modules to the main checkout; the browser-mode
  // dev server must be allowed to serve those real paths or every module fetch
  // from the tester iframe fails outside the main checkout.
  server: {
    fs: {
      allow: [root, realpathSync(path.join(root, 'node_modules'))],
    },
  },
  plugins: [
    // Tailwind is omitted here: bits-ui virtual `<style>` modules conflict with
    // `@tailwindcss/vite` in browser mode. Component specs assert behavior, not CSS.
    svelte({
      // `*.svelte.spec.ts` matches the default `.svelte.` module infix and would be
      // incorrectly compiled as Svelte modules (tests never collect in the browser).
      experimental: {
        compileModule: {
          exclude: [
            '**/*.svelte.spec.ts',
            '**/*.svelte.spec.js',
            '**/*.svelte.test.ts',
            '**/*.svelte.test.js',
          ],
        },
      },
    }),
    paraglideVitePlugin({ project: './project.inlang', outdir: './src/lib/paraglide' }),
  ],
  resolve: {
    alias: {
      $lib: path.resolve(root, 'src/lib'),
      // SvelteKit virtual modules (no sveltekit() plugin in this lean browser config).
      '$app/paths': path.resolve(root, 'src/lib/vitest-stubs/app-paths.ts'),
      '$app/forms': path.resolve(root, 'src/lib/vitest-stubs/app-forms.ts'),
      '$app/navigation': path.resolve(root, 'src/lib/vitest-stubs/app-navigation.ts'),
      '$app/environment': path.resolve(root, 'src/lib/vitest-stubs/app-environment.ts'),
      // PWA plugin is not loaded in this lean browser config.
    },
  },
  // Avoid holding browser module requests behind a full-app dep crawl.
  optimizeDeps: {
    noDiscovery: true,
    holdUntilCrawlEnd: false,
    exclude: ['vitest-browser-svelte', '@testing-library/svelte-core', 'svelte'],
  },
  test: {
    name: 'components',
    expect: { requireAssertions: true },
    setupFiles: ['vitest-browser-svelte'],
    // Phase 4 merge gate: smoke + enrolled component specs. Specs need `$app/*` stubs
    // (in-spec vi.mock) before joining this job.
    include: [
      'src/lib/components/smoke.svelte.spec.ts',
      'src/lib/components/capture-onboarding-overlay.svelte.spec.ts',
      'src/lib/components/provider-onboarding.svelte.spec.ts',
      'src/lib/components/welcome-wizard.svelte.spec.ts',
      'src/lib/components/home-settings-menu.svelte.spec.ts',
      'src/lib/components/approval-card.svelte.spec.ts',
      'src/lib/components/approval-mode-select.svelte.spec.ts',
      'src/lib/components/overview-module.svelte.spec.ts',
      'src/lib/components/app-shell.svelte.spec.ts',
      'src/lib/components/assistant/assistant-panel.svelte.spec.ts',
      'src/lib/components/module-card.svelte.spec.ts',
      'src/lib/components/module-settings-section.svelte.spec.ts',
      'src/lib/components/github-app-connect.svelte.spec.ts',
      'src/lib/components/app-deploy-progress.svelte.spec.ts',
      'src/lib/components/app-build-form.svelte.spec.ts',
      'src/lib/components/app-card.svelte.spec.ts',
      'src/lib/components/add-app-dialog.svelte.spec.ts',
      'src/lib/messages/message-row.svelte.spec.ts',
      'src/lib/components/repo-connect-steps.svelte.spec.ts',
      'src/lib/components/website-activity-panel.svelte.spec.ts',
      'src/lib/components/website-settings.svelte.spec.ts',
      'src/lib/components/app-detail-settings.svelte.spec.ts',
      'src/lib/components/agent-run-feed.svelte.spec.ts',
      'src/lib/components/page/page-header.svelte.spec.ts',
      'src/lib/components/drive/drive-browser.svelte.spec.ts',
      'src/lib/components/contribute/contribute-composer.svelte.spec.ts',
      'src/lib/components/contribute/contribute-board.svelte.spec.ts',
      'modules/brand/water-flow.svelte.spec.ts',
      'src/lib/components/brand-picker/picker.svelte.spec.ts',
    ],
    exclude: ['src/routes/demo/playwright/**/*.ts', '**/*.e2e.ts'],
    fileParallelism: false,
    browser: {
      enabled: true,
      headless: true,
      provider: playwright(),
      instances: [{ browser: 'chromium' }],
    },
  },
})
