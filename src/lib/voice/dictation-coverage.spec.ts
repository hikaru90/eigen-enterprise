import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Voice input on every free-text field (plan/shared-memory-voice-agent-tools.md §2), held by
 * the source. The shared Input and Textarea carry dictation themselves (their own component
 * spec); this guard is for fields written as raw `<textarea>` / text `<input>` elements: a
 * component that has one must render the dictation control (`DictationField` around the
 * field, or `VoiceDictation` in its composer row) or be named below with the reason it has
 * none. A structural check of the markup (tag names and the static `type` attribute), not a
 * reading of what a field means.
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '../../..')

/** Components with raw free-text fields and no dictation, each with why. */
const NO_DICTATION: Record<string, string> = {
  'src/lib/calls/new-call-form.svelte': 'the guests field filters members to pick as chips (search-as-filter)',
  'src/lib/components/app-build-form.svelte': 'shell commands, a port variable and a directory: code',
  'src/lib/components/assistant/run-title-editor.svelte': 'inline rename that saves on blur: tapping a mic would end the edit',
  'src/lib/components/auth-code-step.svelte': 'one-time sign-in code',
  'src/lib/components/domains/domain-buy.svelte': 'domain names and the registrant’s legal contact record (addresses, phone)',
  'src/lib/components/domains/domain-connect.svelte': 'a domain name',
  'src/lib/components/domains/domain-section.svelte': 'a hostname label (www, shop)',
  'src/lib/components/drive/csv-editor.svelte': 'spreadsheet cells in a grid',
  'src/lib/components/drive/drive-browser.svelte': 'search-as-filter by file name',
  'src/lib/components/provider-onboarding.svelte': 'model ids and routing rules; runs before any speech-to-text exists',
  'src/lib/components/welcome-wizard.svelte': 'first-run identity and mail keys, before an AI provider (and so speech-to-text) is set up',
  'src/lib/office/pdf/pdf-viewer.svelte': 'page number and find-in-document',
  'src/lib/office/pptx/pptx-viewer.svelte':
    'speaker notes commit on change after taking the deck’s edit lock on focus; a dictated insert does not go through that flow yet (follow-up)',
  'src/routes/(nucleus)/brand/editor/[setId]/+page.svelte': 'design token values (colours, sizes, font names)',
  'src/routes/(nucleus)/brand/extract/source-options.svelte': 'a web address (www.example.com)',
  'src/routes/(nucleus)/brand/extract/specimen-mini.svelte': 'a type specimen preview, not a form',
  'src/routes/(nucleus)/contribute/modules/+page.svelte': 'search-as-filter by module id or name',
  'src/routes/(nucleus)/m/email/layouts/[id]/+page.svelte': 'MJML/HTML layout source code',
  'src/routes/(nucleus)/m/email/marketing/lists/[id]/+page.svelte': 'CSV import of addresses',
  'src/routes/(nucleus)/settings/backups/+page.svelte': 'storage endpoint, region, bucket, keys and the recovery code',
  'src/routes/(nucleus)/settings/backups/restore/[snapshot]/+page.svelte': 'a restore target name typed to confirm',
  'src/routes/(nucleus)/settings/llm/byok/[provider]/+page.svelte': 'model routing rules',
  'src/routes/invite/+page.svelte': 'accepting an invite happens before sign-in: no member to transcribe for',
  'modules/brand/specimen/Specimen.svelte': 'a component specimen sheet, not a form',
  'modules/contacts/ui/pipeline-board.svelte':
    'table cells that save on change; the contact form (shared Input/Textarea) takes dictation for the same fields',
}

/** The dictation stack itself and the primitives (covered by dictation-field.svelte.spec.ts). */
const OWN = new Set([
  'src/lib/voice/voice-dictation.svelte',
  'src/lib/voice/dictation-field.svelte',
  'src/lib/components/ui/input/input.svelte',
  'src/lib/components/ui/textarea/textarea.svelte',
])

function svelteFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) {
      if (name === 'node_modules' || name === 'paraglide') continue
      out.push(...svelteFiles(full))
    } else if (name.endsWith('.svelte') && !name.includes('test-harness')) {
      out.push(full)
    }
  }
  return out
}

/** Blank out <script>/<style> bodies and comments so only markup is read. */
function markupOnly(source: string): string {
  return source
    .replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(<(script|style)\b[^>]*>)([\s\S]*?)(<\/\2>)/g, (_m, open, _n, body, close) => open + body.replace(/[^\n]/g, ' ') + close)
}

/** The attribute text of the tag opening at `start` (quotes and `{…}` skipped for the `>`). */
function tagText(markup: string, start: number): string {
  let depth = 0
  let quote: string | null = null
  for (let i = start + 1; i < markup.length; i++) {
    const c = markup[i]
    if (quote) {
      if (c === '\\') i++
      else if (c === quote) quote = null
      continue
    }
    if (depth === 0 && (c === '"' || c === "'")) quote = c
    else if (c === '{') depth++
    else if (c === '}') depth--
    else if (c === '>' && depth === 0) return markup.slice(start, i + 1)
  }
  throw new Error(`dictation-coverage: unterminated tag at offset ${start}`)
}

/** Raw elements a person types free text into: textareas, and inputs typed text (or untyped). */
export function freeTextFields(source: string): string[] {
  const markup = markupOnly(source)
  const found: string[] = []
  for (const m of markup.matchAll(/<(textarea|input)\b/g)) {
    const tag = tagText(markup, m.index)
    if (/\breadonly\b/.test(tag) && !/\breadonly=\{/.test(tag)) continue
    if (m[1] === 'textarea') {
      found.push(tag)
      continue
    }
    if (/\{\.\.\.[^}]*\}/.test(tag) && !/\btype=/.test(tag)) continue // spread: typed by its caller
    const type = /\btype=(?:"([^"]*)"|'([^']*)'|\{)/.exec(tag)
    if (!type) found.push(tag)
    else if (type[0].endsWith('{')) found.push(tag) // decided at run time: it can be text
    else if ((type[1] ?? type[2]) === 'text') found.push(tag)
  }
  return found
}

function rendersDictation(source: string): boolean {
  const markup = markupOnly(source)
  return /<(?:VoiceDictation|DictationField)\b/.test(markup)
}

describe('dictation coverage of raw free-text fields', () => {
  const files = [...svelteFiles(path.join(repo, 'src')), ...svelteFiles(path.join(repo, 'modules'))]
    .map((f) => path.relative(repo, f).split(path.sep).join('/'))
    .filter((f) => !OWN.has(f))
  const withFields = files.filter((f) => freeTextFields(readFileSync(path.join(repo, f), 'utf-8')).length > 0)

  it('finds the raw fields it guards (the scan reads markup)', () => {
    expect(freeTextFields('<textarea bind:value></textarea><input type="email" /><input bind:value={x} /><input type="checkbox" />')).toHaveLength(2)
    expect(freeTextFields('<script>const t = "<textarea>"</script><input type={kind} />')).toHaveLength(1)
    expect(freeTextFields('<textarea readonly>key</textarea>')).toHaveLength(0)
    expect(withFields.length).toBeGreaterThan(10)
  })

  it('every component with a raw free-text field renders dictation or says why not', () => {
    const missing = withFields.filter(
      (f) => !(f in NO_DICTATION) && !rendersDictation(readFileSync(path.join(repo, f), 'utf-8')),
    )
    expect(missing).toEqual([])
  })

  it('every exemption is still real: the file exists, has raw free-text fields and no dictation', () => {
    const stale = Object.keys(NO_DICTATION).filter(
      (f) => !withFields.includes(f) || rendersDictation(readFileSync(path.join(repo, f), 'utf-8')),
    )
    expect(stale).toEqual([])
  })
})
