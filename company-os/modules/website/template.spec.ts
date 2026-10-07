import { describe, expect, it } from 'vitest';
import { renderHtml } from './template.ts';
import type { SiteContent } from './copy.ts';

const CONTENT: SiteContent = {
	schema: 'company-os/website@0.1',
	language: 'de',
	company: { name: 'Bäckerei Hinkel' },
	sections: [
		{ id: 's1', type: 'hero', headline: 'Frisches Brot seit 1911', subline: 'Sauerteig aus Ehrenfeld', sources: ['company.name'] },
		{ id: 's2', type: 'about', title: 'Unsere Bäckerei', body: ['Erster Absatz.', 'Zweiter Absatz.'], sources: ['company.differentiator'] },
		{
			id: 's3',
			type: 'offer',
			title: 'Was es bei uns gibt',
			items: [
				{ title: 'Sauerteigbrot', text: 'Nach dem Rezept von 1911.' },
				{ title: 'Croissants', text: 'Jeden Morgen frisch.' }
			],
			sources: ['company.audience']
		},
		{
			id: 's4',
			type: 'cta',
			title: 'Vorbestellen',
			text: 'Schreiben Sie uns.',
			buttonLabel: 'E-Mail schreiben',
			action: { type: 'email', value: 'brot@hinkel.de' },
			sources: ['company.cta']
		}
	]
};

describe('renderHtml', () => {
	it('renders every section and the company name', () => {
		const html = renderHtml(CONTENT);
		expect(html).toContain('Frisches Brot seit 1911');
		expect(html).toContain('Sauerteig aus Ehrenfeld');
		expect(html).toContain('Unsere Bäckerei');
		expect(html).toContain('Erster Absatz.');
		expect(html).toContain('Sauerteigbrot');
		expect(html).toContain('Vorbestellen');
		expect(html).toContain('Bäckerei Hinkel');
	});

	it('sets the document language from the content', () => {
		expect(renderHtml(CONTENT)).toContain('<html lang="de">');
		expect(renderHtml({ ...CONTENT, language: 'en' })).toContain('<html lang="en">');
	});

	it('escapes HTML in copy — the site cannot execute what the LLM wrote', () => {
		const hostile: SiteContent = {
			...CONTENT,
			sections: [
				{
					id: 's1',
					type: 'hero',
					headline: '<script>alert(1)</script>',
					subline: 's',
					sources: ['company.name']
				}
			]
		};
		const html = renderHtml(hostile);
		expect(html).not.toContain('<script>alert(1)</script>');
		expect(html).toContain('&lt;script&gt;');
	});

	it('monogram fallback from the company name when there are no assets', () => {
		const html = renderHtml(CONTENT);
		expect(html).toContain('>BH<');
		const single = renderHtml({ ...CONTENT, company: { name: 'Ada' } });
		expect(single).toContain('>A<');
	});

	it('renders the cta action as a real link', () => {
		const html = renderHtml(CONTENT);
		expect(html).toContain('href="mailto:brot@hinkel.de"');
	});

	it('omits the cta button entirely when the founder gave no address', () => {
		const noAction: SiteContent = {
			...CONTENT,
			sections: [
				{ id: 's4', type: 'cta', title: 'Vorbestellen', text: 'Schreiben Sie uns.', sources: ['company.cta'] }
			]
		};
		const html = renderHtml(noAction);
		expect(html).toContain('Schreiben Sie uns.');
		expect(html).not.toContain('mailto:');
		expect(html).not.toContain('<a class="button"');
	});

	it('inlines the theme tokens and is deterministic', () => {
		const a = renderHtml(CONTENT, { themeCss: ':root{--co-accent:#7a3b2e}' });
		const b = renderHtml(CONTENT, { themeCss: ':root{--co-accent:#7a3b2e}' });
		expect(a).toBe(b);
		expect(a).toContain('--co-accent:#7a3b2e');
	});

	it('fails loud on an unknown section type', () => {
		const bad = { ...CONTENT, sections: [{ id: 'x', type: 'pricing', sources: [] }] as unknown as SiteContent['sections'] };
		expect(() => renderHtml(bad as SiteContent)).toThrow(/pricing/);
	});
});
