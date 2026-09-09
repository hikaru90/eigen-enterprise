/**
 * Token↔element mapping for the specimen canvas (phase-2d M6, V8): the
 * deterministic knowledge base powering click-to-highlight. For every section
 * of modules/brand/specimen/Specimen.svelte it lists the cssVar names that
 * drive its rendering — pure data, zero heuristics, zero LLM (V10). The
 * Specimen component consumes exactly these variables per section; when the
 * component's styling changes, this table changes with it.
 */

export const SPECIMEN_SECTIONS = ['nav', 'hero', 'cards', 'form', 'pricing', 'footer'] as const

export type SpecimenSectionId = (typeof SPECIMEN_SECTIONS)[number]

export const SECTION_DRIVERS: Record<SpecimenSectionId, readonly string[]> = {
  nav: [
    '--background',
    '--foreground',
    '--primary',
    '--border',
    '--font-sans',
    '--text-step-1',
    '--text-step-0',
    '--space-2',
    '--space-3',
    '--radius-md',
    '--duration-fast',
    '--ease-enter',
  ],
  hero: [
    '--background',
    '--foreground',
    '--primary',
    '--primary-foreground',
    '--secondary',
    '--secondary-foreground',
    '--font-display',
    '--font-sans',
    '--text-step-3',
    '--text-step-3-lh',
    '--text-step-3-tracking',
    '--text-step-1',
    '--text-step-0',
    '--space-2',
    '--space-3',
    '--radius-md',
  ],
  cards: [
    '--background',
    '--card',
    '--card-foreground',
    '--border',
    '--shadow-1',
    '--accent',
    '--muted-foreground',
    '--font-sans',
    '--text-step-1',
    '--text-step-0',
    '--text-step-0-lh',
    '--space-2',
    '--space-3',
    '--radius-lg',
  ],
  form: [
    '--card',
    '--card-foreground',
    '--foreground',
    '--muted-foreground',
    '--input',
    '--ring',
    '--border',
    '--popover',
    '--popover-foreground',
    '--accent',
    '--accent-foreground',
    '--primary',
    '--primary-foreground',
    '--font-sans',
    '--text-step-0',
    '--space-2',
    '--space-3',
    '--radius-sm',
    '--radius-md',
    '--duration-fast',
    '--ease-enter',
  ],
  pricing: [
    '--card',
    '--card-foreground',
    '--muted',
    '--muted-foreground',
    '--border',
    '--primary',
    '--primary-foreground',
    '--font-display',
    '--font-mono',
    '--font-sans',
    '--text-step-2',
    '--text-step-0',
    '--space-1',
    '--space-2',
    '--space-3',
    '--radius',
    '--radius-md',
    '--radius-xl',
    '--shadow-2',
    '--duration-fast',
    '--ease-enter',
  ],
  footer: [
    '--secondary',
    '--secondary-foreground',
    '--muted-foreground',
    '--border',
    '--font-sans',
    '--text-step-0',
    '--space-2',
    '--space-3',
  ],
}

export type TokenDrivers = {
  /** Element → driving cssVar names (canvas click side). */
  sectionTokens: Record<SpecimenSectionId, readonly string[]>
  /** Token → elements it drives (panel side). */
  tokenSections: Record<string, SpecimenSectionId[]>
}

function buildRegistry(): TokenDrivers {
  const tokenSections: Record<string, SpecimenSectionId[]> = {}
  for (const section of SPECIMEN_SECTIONS) {
    for (const token of SECTION_DRIVERS[section]) {
      const sections = (tokenSections[token] ??= [])
      if (!sections.includes(section)) sections.push(section)
    }
  }
  return {
    sectionTokens: { ...SECTION_DRIVERS },
    tokenSections,
  }
}

const REGISTRY: TokenDrivers = buildRegistry()

/** Static registry in both directions; deterministic, computed once. */
export function tokenDrivers(): TokenDrivers {
  return {
    sectionTokens: { ...REGISTRY.sectionTokens },
    tokenSections: Object.fromEntries(
      Object.entries(REGISTRY.tokenSections).map(([token, sections]) => [token, [...sections]]),
    ),
  }
}
