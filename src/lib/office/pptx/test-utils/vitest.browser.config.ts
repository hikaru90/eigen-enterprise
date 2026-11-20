import base from '../../../../../vitest.browser.config'

/**
 * Runs only this format's component specs (`*.svelte.spec.ts` under
 * src/lib/office/pptx) with the shared browser setup:
 *   node scripts/patch-vitest-browser-iframeid.mjs && npx vitest run --config src/lib/office/pptx/test-utils/vitest.browser.config.ts
 * The merge gate runs them once the shared config names them (include list, and
 * @xmldom/xmldom in optimizeDeps.include).
 */
export default {
  ...base,
  // @xmldom/xmldom ships CommonJS; the lean browser runner only pre-bundles what it is told to.
  optimizeDeps: { ...base.optimizeDeps, include: [...(base.optimizeDeps?.include ?? []), '@xmldom/xmldom'] },
  test: { ...base.test, include: ['src/lib/office/pptx/**/*.svelte.spec.ts'] },
}
