import type { Emoji, MessagesDataset } from 'emojibase'

/**
 * The full emoji picker's catalog, from the Unicode emoji dataset
 * (emojibase-data, MIT): every emoji in Unicode's groups and order, with its
 * CLDR name and keywords for search. The dataset (~100 kB gzipped) loads on
 * the picker's first open, never with the page.
 */

/**
 * The newest Emoji version the picker offers. Newer ones render as empty boxes
 * on many current systems and may postdate the server's Unicode tables; the
 * server still accepts any RGI emoji sent by API or the CLI.
 */
export const PICKER_MAX_EMOJI_VERSION = 15.1

/** Unicode's "component" group: skin tones and hair styles on their own, nothing to pick. */
const COMPONENT_GROUP_KEY = 'component'

export type CatalogEmoji = { emoji: string; label: string; tags: string[] }
export type CatalogGroup = { key: string; label: string; emoji: CatalogEmoji[] }
export type EmojiCatalog = { groups: CatalogGroup[] }

const sentence = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

export function buildEmojiCatalog(data: readonly Emoji[], messages: MessagesDataset): EmojiCatalog {
  const groups = [...messages.groups]
    .sort((a, b) => a.order - b.order)
    .filter((g) => g.key !== COMPONENT_GROUP_KEY)
    .map((g) => ({
      key: g.key,
      label: sentence(g.message),
      emoji: data
        .filter((e) => e.group === g.order && e.version <= PICKER_MAX_EMOJI_VERSION)
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
        .map((e) => ({ emoji: e.emoji, label: e.label, tags: e.tags ?? [] })),
    }))
  return { groups }
}

/** Emoji whose name or keywords contain every typed word (a search box, not a meaning). */
export function searchEmoji(catalog: EmojiCatalog, query: string): CatalogEmoji[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return []
  return catalog.groups
    .flatMap((g) => g.emoji)
    .filter((e) => {
      const hay = [e.label, ...e.tags].join(' ').toLowerCase()
      return words.every((w) => hay.includes(w))
    })
}

let loading: Promise<EmojiCatalog> | null = null

/** Loads the dataset once per page, as its own chunk. */
export function loadEmojiCatalog(): Promise<EmojiCatalog> {
  loading ??= Promise.all([import('emojibase-data/en/data.json'), import('emojibase-data/en/messages.json')]).then(([d, m]) =>
    buildEmojiCatalog(d.default, m.default),
  )
  return loading
}
