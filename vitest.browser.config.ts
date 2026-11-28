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
      '$app/state': path.resolve(root, 'src/lib/vitest-stubs/app-state.svelte.ts'),
      // PWA plugin is not loaded in this lean browser config.
    },
  },
  // Avoid holding browser module requests behind a full-app dep crawl.
  optimizeDeps: {
    noDiscovery: true,
    holdUntilCrawlEnd: false,
    exclude: ['vitest-browser-svelte', '@testing-library/svelte-core', 'svelte'],
    // CommonJS packages components import (noDiscovery: they must be listed):
    // the office viewers (@xmldom/xmldom), the CSV grid (papaparse), the
    // spreadsheet's formula functions (@formulajs/formulajs pulls in jstat and bessel).
    include: ['@xmldom/xmldom', 'papaparse', '@formulajs/formulajs'],
  },
  test: {
    name: 'components',
    expect: { requireAssertions: true },
    setupFiles: ['vitest-browser-svelte'],
    // Phase 4 merge gate: smoke + enrolled component specs. Specs need `$app/*` stubs
    // (in-spec vi.mock) before joining this job.
    include: [
      'src/lib/components/smoke.svelte.spec.ts',
      'src/routes/(nucleus)/m/email/mailboxes/mailboxes-page.svelte.spec.ts',
      'src/routes/(nucleus)/m/email/reputation/reputation-page.svelte.spec.ts',
      'src/lib/components/settings/speech-status.svelte.spec.ts',
      'src/routes/(nucleus)/settings/members/members-page.svelte.spec.ts',
      'src/lib/components/settings/ai-usage-overview.svelte.spec.ts',
      'src/lib/components/ai-usage-meter.svelte.spec.ts',
      'src/lib/components/settings/logo-cropper.svelte.spec.ts',
      'src/routes/(nucleus)/brand/material/flyer-preview.svelte.spec.ts',
      'src/routes/(nucleus)/brand/material/banner-preview.svelte.spec.ts',
      'src/routes/(nucleus)/brand/material/poster-preview.svelte.spec.ts',
      'src/routes/(nucleus)/brand/material/merch-preview.svelte.spec.ts',
      'src/routes/(nucleus)/brand/material/material-workbench.svelte.spec.ts',
      'src/routes/(nucleus)/brand/social/social-library.svelte.spec.ts',
      'src/routes/(nucleus)/brand/social/social-pdf.svelte.spec.ts',
      'src/routes/(nucleus)/brand/extract/source-options.svelte.spec.ts',
      'src/lib/components/capture-onboarding-overlay.svelte.spec.ts',
      'src/lib/components/provider-onboarding.svelte.spec.ts',
      'src/lib/components/welcome-wizard.svelte.spec.ts',
      'src/lib/components/home-settings-menu.svelte.spec.ts',
      'src/lib/theme/theme-switch.svelte.spec.ts',
      'src/lib/components/audio-devices-settings.svelte.spec.ts',
      'src/lib/pwa/install-app-dialog.svelte.spec.ts',
      'src/lib/pwa/notifications-banner.svelte.spec.ts',
      'src/lib/pwa/push-devices.svelte.spec.ts',
      'src/lib/components/approval-card.svelte.spec.ts',
      'src/lib/components/approval-mode-select.svelte.spec.ts',
      'src/lib/components/overview-module.svelte.spec.ts',
      'src/lib/components/app-shell.svelte.spec.ts',
      'src/lib/components/assistant/assistant-panel.svelte.spec.ts',
      'src/lib/components/assistant/assistant-history.svelte.spec.ts',
      'src/lib/components/module-card.svelte.spec.ts',
      'src/lib/components/error-panel.svelte.spec.ts',
      'src/lib/components/error-notice.svelte.spec.ts',
      'src/routes/(nucleus)/settings/company/company-page.svelte.spec.ts',
      'src/routes/(nucleus)/settings/llm/ai-page.svelte.spec.ts',
      'src/routes/(nucleus)/settings/domains/domains-page.svelte.spec.ts',
      'src/routes/(nucleus)/settings/modules/plugins-page.svelte.spec.ts',
      'src/routes/(nucleus)/dashboard.svelte.spec.ts',
      // Brackets/parentheses escaped: [snapshot] is a glob class otherwise.
      'src/routes/\\(nucleus\\)/settings/backups/restore/\\[snapshot\\]/restore-page.svelte.spec.ts',
      'src/routes/(nucleus)/settings/updates/updates-page.svelte.spec.ts',
      'src/lib/components/module-settings-section.svelte.spec.ts',
      'src/lib/components/github-app-connect.svelte.spec.ts',
      'src/lib/components/app-deploy-progress.svelte.spec.ts',
      'src/lib/components/app-build-form.svelte.spec.ts',
      'src/lib/components/app-card.svelte.spec.ts',
      'src/lib/components/add-app-dialog.svelte.spec.ts',
      // AI Co-workers (plan/phase-ai-coworkers.md C5): org chart, create from a template, members rows.
      'src/lib/coworkers/*.svelte.spec.ts',
      'src/lib/components/settings/member-row.svelte.spec.ts',
      'src/lib/messages/message-row.svelte.spec.ts',
      'src/lib/messages/message-edit.svelte.spec.ts',
      'src/lib/messages/message-composer.svelte.spec.ts',
      'src/lib/messages/drive-folder-picker.svelte.spec.ts',
      'src/lib/messages/emoji-picker.svelte.spec.ts',
      'src/lib/messages/reply-quote.svelte.spec.ts',
      'src/lib/messages/voice-player.svelte.spec.ts',
      'src/lib/messages/presence-dot.svelte.spec.ts',
      'src/lib/messages/presence-nav.svelte.spec.ts',
      'src/lib/messages/conversation-row.svelte.spec.ts',
      'src/lib/presence/*.svelte.spec.ts',
      'src/lib/calls/call-view.svelte.spec.ts',
      'src/lib/calls/call-brain.svelte.spec.ts',
      'src/lib/calls/call-chat.svelte.spec.ts',
      'src/lib/calls/incoming-call-toast.svelte.spec.ts',
      'src/lib/calls/call-button.svelte.spec.ts',
      'src/lib/calls/call-presence.svelte.spec.ts',
      'src/lib/calls/new-call-form.svelte.spec.ts',
      'src/lib/calls/guest-join.svelte.spec.ts',
      'src/lib/components/repo-connect-steps.svelte.spec.ts',
      'src/lib/components/website-activity-panel.svelte.spec.ts',
      'src/lib/components/website-settings.svelte.spec.ts',
      'src/lib/components/app-detail-settings.svelte.spec.ts',
      'src/lib/components/agent-run-feed.svelte.spec.ts',
      'src/lib/components/page/page-header.svelte.spec.ts',
      'src/lib/components/ui/info-popover.svelte.spec.ts',
      'src/lib/components/page/status-pill.svelte.spec.ts',
      'src/lib/components/ui/info-popover.svelte.spec.ts',
      'src/lib/components/drive/drive-browser.svelte.spec.ts',
      'src/lib/components/drive/drive-selection.svelte.spec.ts',
      'src/lib/components/drive/drive-presence.svelte.spec.ts',
      'src/lib/components/drive/drive-privacy-note.svelte.spec.ts',
      'src/lib/components/drive/archived-view.svelte.spec.ts',
      'src/lib/components/drive/revisions-panel.svelte.spec.ts',
      'src/lib/components/drive/share-dialog.svelte.spec.ts',
      'src/lib/components/drive/upload-conflict-dialog.svelte.spec.ts',
      // Drive: run a web app folder (plan/phase-drive-app-preview.md).
      'src/lib/components/drive/app-preview.svelte.spec.ts',
      // Office viewers (plan/phase-office-files.md): every format's component specs.
      'src/lib/office/**/*.svelte.spec.ts',
      // Stale-build reload notice (bug 593f7e08).
      'src/lib/components/app-updated-banner.svelte.spec.ts',
      'src/routes/\\(nucleus\\)/drive/file/\\[id\\]/file-page.svelte.spec.ts',
      'src/routes/(nucleus)/drive/github/github-page.svelte.spec.ts',
      'src/routes/(nucleus)/m/memory/memory-privacy-note.svelte.spec.ts',
      'src/routes/(nucleus)/m/memory/settings/your-data.svelte.spec.ts',
      'src/routes/(nucleus)/m/memory/tasks/assigned-tasks.svelte.spec.ts',
      'src/routes/(nucleus)/m/memory/reminders/reminders.svelte.spec.ts',
      'src/routes/(nucleus)/m/memory/capture/intake/brain-intake.svelte.spec.ts',
      'src/routes/(nucleus)/m/memory/questions/questions.svelte.spec.ts',
      'src/routes/(nucleus)/m/memory/handover/handover.svelte.spec.ts',
      'src/routes/timeline/temporal-event-delete-button.svelte.spec.ts',
      'src/routes/timeline/temporal-event-status-button.svelte.spec.ts',
      'src/routes/timeline/temporal-event-detail.svelte.spec.ts',
      'src/lib/components/tell-the-brain.svelte.spec.ts',
      'src/lib/components/capture-recent-thoughts.svelte.spec.ts',
      'src/routes/timeline/timeline-unassigned-tasks.svelte.spec.ts',
      'src/routes/(nucleus)/m/memory/projects/roadmap-pinned-card.svelte.spec.ts',
      'src/routes/timeline/timeline-add-task.svelte.spec.ts',
      'src/routes/timeline/timeline-tasks-ux.svelte.spec.ts',
      'src/lib/components/memory-sharing.svelte.spec.ts',
      'src/routes/(nucleus)/m/memory/projects/team-projects.svelte.spec.ts',
      'src/lib/components/contribute/contribute-composer.svelte.spec.ts',
      'src/lib/components/contribute/contribute-board.svelte.spec.ts',
      'src/lib/components/contribute/contribute-views.svelte.spec.ts',
      'src/lib/components/contribute/share-settings-card.svelte.spec.ts',
      'src/lib/voice/voice-dictation.svelte.spec.ts',
      'src/lib/voice/dictation-field.svelte.spec.ts',
      'src/lib/components/assistant/voice-output-toggle.svelte.spec.ts',
      'src/lib/speech/voice-playback-controls.svelte.spec.ts',
      'src/lib/components/assistant/brain-knows.svelte.spec.ts',
      'modules/brand/water-flow.svelte.spec.ts',
      'modules/contacts/ui/*.svelte.spec.ts',
      'modules/calendar/ui/*.svelte.spec.ts',
      'modules/email/inbox/ui/*.svelte.spec.ts',
      'src/lib/components/email/*.svelte.spec.ts',
      'src/lib/components/brand-picker/picker.svelte.spec.ts',
      'src/routes/login/login-page.svelte.spec.ts',
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
