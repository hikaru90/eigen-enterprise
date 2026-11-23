import adapter from '@sveltejs/adapter-node'
import { mdsvex } from 'mdsvex'

/** @type {import('@sveltejs/kit').Config} */
const config = {
  compilerOptions: {
    // Force runes mode for the project, except for libraries. Can be removed in svelte 6.
    runes: ({ filename }) => (filename.split(/[/\\]/).includes('node_modules') ? undefined : true),
  },
  kit: {
    serviceWorker: {
      register: false,
    },
    adapter: adapter(),
    // Each release is its own build (name: build time). Tabs poll
    // /_app/version.json so `updated.current` flips after an install and the
    // root layout turns the next navigation into a full page load (bug 593f7e08).
    version: { pollInterval: 60_000 },
    // The cross-site form check runs in src/hooks.server.ts (handleCsrf) — the
    // same rule, plus the one exemption Amazon SNS needs (src/lib/server/csrf.ts).
    csrf: { trustedOrigins: ['*'] },
    paths: {
      relative: false,
    },
    typescript: {
      config: (config) => ({
        ...config,
        // modules/** is part of the app program: brand UI assets (e.g.
        // modules/brand/water-flow.svelte) are imported by routes and must be
        // visible to svelte-check and eslint's projectService.
        include: [
          ...config.include,
          '../drizzle.config.ts',
          '../modules/**/*.ts',
          '../modules/**/*.svelte',
        ],
      }),
    },
  },
  preprocess: [mdsvex({ extensions: ['.svx', '.md'] })],
  extensions: ['.svelte', '.svx', '.md'],
}

export default config
