/**
 * The website template — pure content → standalone HTML.
 *
 * Register: typographic, handmade. System serif stack (no webfont fetches —
 * the site works offline and spies nobody), warm paper, hairline rules,
 * generous rhythm. A monogram stands in when the founder has no logo —
 * intentional, not placeholder-gray.
 *
 * Everything the LLM wrote goes through HTML escaping. The rendered file is
 * deterministic: same content in, byte-identical HTML out (git commits
 * must not churn).
 */

import type { SiteContent, SiteSection } from './copy.ts';

export type RenderOptions = {
	/** Theme tokens CSS, inlined into the page (the founder-editable theme.css). */
	themeCss?: string;
}

function escapeHtml(value: string): string {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&#39;');
}

/** Format-level scheme check — code may validate format, never meaning. */
function safeHref(action: NonNullable<SiteSection['action']>): string {
	const value = action.value.trim();
	if (action.type === 'email') return `mailto:${encodeURI(value)}`;
	if (action.type === 'phone') return `tel:${value.replace(/[\s()-]/g, '')}`;
	if (!/^https?:\/\//.test(value)) {
		throw new Error(`template: cta url must start with http(s):// — got "${value}".`);
	}
	return encodeURI(value);
}

/** Deterministic monogram: initials of the first words, one letter for one word. */
export function monogram(companyName: string): string {
	const words = companyName.trim().split(/\s+/).filter(Boolean);
	if (words.length === 0) throw new Error('template: company name is empty — cannot render a monogram.');
	const letters = words.slice(0, 2).map((w) => [...w][0]!.toUpperCase());
	return letters.join('');
}

const TOKENS_DEFAULT = `:root {
  --co-bg: #faf6ef;
  --co-ink: #26221c;
  --co-muted: #6f675c;
  --co-accent: #8a4b2f;
  --co-display-font: "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif;
  --co-body-font: "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif;
}`;

const BASE_CSS = `*, *::before, *::after { box-sizing: border-box; }
html { background: var(--co-bg); color: var(--co-ink); }
body {
  margin: 0;
  font-family: var(--co-body-font);
  font-size: 1.125rem;
  line-height: 1.7;
}
.page { max-width: 42rem; margin: 0 auto; padding: 4rem 1.5rem 5rem; }
.monogram {
  display: inline-flex; align-items: center; justify-content: center;
  width: 3.2rem; height: 3.2rem;
  border: 1.5px solid var(--co-ink); border-radius: 2px;
  font-family: var(--co-display-font);
  font-size: 1.3rem; letter-spacing: 0.08em;
  margin: 0 0 2.5rem;
}
h1, h2 { font-family: var(--co-display-font); font-weight: 600; line-height: 1.15; margin: 0; }
.hero h1 { font-size: clamp(2.2rem, 6vw, 3.4rem); }
.hero .subline { font-size: 1.35rem; color: var(--co-muted); margin: 1.25rem 0 0; }
section { margin-top: 4.5rem; padding-top: 2.5rem; border-top: 1px solid rgba(38, 34, 28, 0.14); }
section h2 { font-size: 1.7rem; }
section p { margin: 1.25rem 0 0; }
.offer ul { list-style: none; margin: 1.75rem 0 0; padding: 0; }
.offer li { margin-top: 1.5rem; }
.offer li h3 { font-family: var(--co-display-font); font-size: 1.25rem; margin: 0; }
.offer li p { margin: 0.4rem 0 0; }
.cta { text-align: left; }
.cta .button {
  display: inline-block; margin-top: 1.75rem;
  background: var(--co-accent); color: var(--co-bg);
  font-family: var(--co-body-font); font-size: 1.1rem;
  padding: 0.8rem 1.6rem; border-radius: 2px; text-decoration: none;
}
footer { margin-top: 5rem; padding-top: 2rem; border-top: 1px solid rgba(38, 34, 28, 0.14);
  color: var(--co-muted); font-size: 0.95rem; }`;

export function renderHtml(content: SiteContent, opts: RenderOptions = {}): string {
	const sections = content.sections
		.map((section) => renderSection(section, content))
		.join('\n\n');
	return `<!doctype html>
<html lang="${escapeHtml(content.language)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(content.company.name)}</title>
<style>
${opts.themeCss?.trim() || TOKENS_DEFAULT}

${BASE_CSS}
</style>
</head>
<body>
<div class="page">
<header class="brand">
  <p class="monogram" aria-hidden="true">${escapeHtml(monogram(content.company.name))}</p>
</header>
${sections}
<footer>${escapeHtml(content.company.name)}</footer>
</div>
</body>
</html>
`;
}

function renderSection(section: SiteSection, content: SiteContent): string {
	switch (section.type) {
		case 'hero':
			return `<header class="hero">
  <h1>${escapeHtml(requireField(section.headline, 'hero.headline'))}</h1>
  <p class="subline">${escapeHtml(requireField(section.subline, 'hero.subline'))}</p>
</header>`;
		case 'about':
		case 'differentiator':
			return `<section class="${section.type}">
  <h2>${escapeHtml(requireField(section.title, `${section.type}.title`))}</h2>
  ${(section.body ?? []).map((p) => `  <p>${escapeHtml(p)}</p>`).join('\n')}
</section>`;
		case 'offer':
			return `<section class="offer">
  <h2>${escapeHtml(requireField(section.title, 'offer.title'))}</h2>
  <ul>
${(section.items ?? [])
	.map(
		(item) => `    <li>
      <h3>${escapeHtml(item.title)}</h3>
      <p>${escapeHtml(item.text)}</p>
    </li>`
	)
	.join('\n')}
  </ul>
</section>`;
		case 'cta': {
			const href = section.action ? safeHref(section.action) : null;
			const button =
				href !== null
					? `\n  <a class="button" href="${escapeHtml(href)}">${escapeHtml(requireField(section.buttonLabel, 'cta.buttonLabel'))}</a>`
					: '';
			return `<section class="cta">
  <h2>${escapeHtml(requireField(section.title, 'cta.title'))}</h2>
  <p>${escapeHtml(requireField(section.text, 'cta.text'))}</p>${button}
</section>`;
		}
		default: {
			const exhaustive: never = section.type;
			throw new Error(`template: unknown section type "${String(exhaustive)}" for ${content.company.name}.`);
		}
	}
}

function requireField(value: string | undefined, what: string): string {
	if (value === undefined || value.trim().length === 0) {
		throw new Error(`template: ${what} is missing — the content contract requires it.`);
	}
	return value;
}
