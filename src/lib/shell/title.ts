/** The product name every browser title ends with. */
export const PRODUCT_NAME = 'eigenEnterprise'

/**
 * One title pattern for every page (phase-cohesion C2):
 * "<Page> · <Section> · eigenEnterprise". Empty parts are dropped, so a
 * section's own page is "<Section> · eigenEnterprise".
 */
export function docTitle(...parts: Array<string | null | undefined>): string {
  return [...parts.map((p) => p?.trim()).filter((p): p is string => !!p), PRODUCT_NAME].join(' · ')
}
