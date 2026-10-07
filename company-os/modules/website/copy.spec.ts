import { describe, expect, it } from 'vitest';
import { FakeClient, finishStop, text } from '../../src/lib/server/testing.ts';
import type { LlmClient } from '../../src/lib/server/llm.ts';
import { auditCopy, draftCopy, type SiteContent } from './copy.ts';

/** Drafts arrive without ids — the code assigns them during validation. */
type RawSection = Omit<SiteContent['sections'][number], 'id'>;

const ANSWERS: Record<string, string> = {
	'company.name': 'Bäckerei Hinkel',
	'company.audience': 'Familien in Köln-Ehrenfeld, die morgens frisches Brot wollen',
	'company.cta': 'Sie sollen vorbestellen — per E-Mail an brot@hinkel.de',
	'company.tone': 'Herzlich, handgemacht, ein bisschen oldschool',
	'company.differentiator': 'Wir backen seit 1911 nach dem gleichen Sauerteig-Rezept',
	'site.language': 'Deutsch'
};

function clientReturning(json: string): LlmClient {
	return new FakeClient([[text(json), finishStop]]) as unknown as LlmClient;
}

describe('draftCopy', () => {
	it('sends ONLY the founder answers to the LLM — no invented seed content', async () => {
		const fake = new FakeClient([[text('{}'), finishStop]]);
		try {
			await draftCopy(fake as unknown as LlmClient, ANSWERS);
		} catch {
			// invalid draft content — irrelevant here
		}
		const sent = fake.calls[0]!.messages.map((m) => m.content ?? '').join('\n');
		expect(sent).toContain('Bäckerei Hinkel');
		expect(sent).toContain('brot@hinkel.de');
		// nothing the founder did not say
		expect(sent).not.toMatch(/Leidenschaft|familiengeführt|ihren Traum/i);
	});

	it('parses the LLM JSON even when it arrives in a code fence', async () => {
		const content: SiteContent = {
			schema: 'company-os/website@0.1',
			language: 'de',
			company: { name: 'Bäckerei Hinkel' },
			sections: [
				{
					id: 's1',
					type: 'hero',
					headline: 'Frisches Brot seit 1911',
					subline: 'Sauerteig aus Köln-Ehrenfeld',
					sources: ['company.name', 'company.differentiator']
				}
			]
		};
		const client = clientReturning('Hier ist die Kopie:\n```json\n' + JSON.stringify(content) + '\n```');
		const out = await draftCopy(client, ANSWERS);
		expect(out.sections[0]!.headline).toBe('Frisches Brot seit 1911');
	});

	it('fails loud on structurally invalid drafts (unknown section type)', async () => {
		const client = clientReturning(
			JSON.stringify({
				schema: 'company-os/website@0.1',
				language: 'de',
				company: { name: 'x' },
				sections: [{ type: 'pricing', headline: '3,50 €', sources: [] }]
			})
		);
		await expect(draftCopy(client, ANSWERS)).rejects.toThrow(/pricing/);
	});

	it('fails loud when a section cites no source answers', async () => {
		const client = clientReturning(
			JSON.stringify({
				schema: 'company-os/website@0.1',
				language: 'de',
				company: { name: 'Bäckerei Hinkel' },
				sections: [{ type: 'hero', headline: 'h', subline: 's', sources: [] }]
			})
		);
		await expect(draftCopy(client, ANSWERS)).rejects.toThrow(/sources/);
	});

	it('fails loud when a section cites an answer the founder never gave', async () => {
		const client = clientReturning(
			JSON.stringify({
				schema: 'company-os/website@0.1',
				language: 'de',
				company: { name: 'Bäckerei Hinkel' },
				sections: [{ type: 'hero', headline: 'h', subline: 's', sources: ['company.assets'] }]
			})
		);
		await expect(draftCopy(client, ANSWERS)).rejects.toThrow(/company\.assets/);
	});

	it('fails loud on unparseable LLM output', async () => {
		const client = clientReturning('no json here at all');
		await expect(draftCopy(client, ANSWERS)).rejects.toThrow(/JSON/i);
	});
});

describe('auditCopy (W5 hard filter)', () => {
	const GOOD: SiteContent = {
		schema: 'company-os/website@0.1',
		language: 'de',
		company: { name: 'Bäckerei Hinkel' },
		sections: [
			{
				id: 's1',
				type: 'about',
				title: 'Seit 1911',
				body: ['Wir backen nach dem gleichen Sauerteig-Rezept von 1911.'],
				sources: ['company.differentiator']
			}
		]
	};

	it('accepts copy fully supported by the answers', async () => {
		const client = clientReturning(JSON.stringify({ violations: [] }));
		const out = await auditCopy(client, GOOD, ANSWERS);
		expect(out).toEqual([]);
	});

	it('rejects an invented price and names the offending sentence', async () => {
		const withPrice: SiteContent = {
			...GOOD,
			sections: [
				{
					id: 's1',
					type: 'about',
					title: 'Seit 1911',
					body: ['Unser Brotnormale kostet 3,50 €.'],
					sources: ['company.differentiator']
				}
			]
		};
		const client = clientReturning(
			JSON.stringify({
				violations: [
					{
						section: 'about',
						sentence: 'Unser Brotnormale kostet 3,50 €.',
						reason: 'founder never gave a price'
					}
				]
			})
		);
		await expect(auditCopy(client, withPrice, ANSWERS)).rejects.toThrow(/3,50/);
	});

	it('rejects invented legal claims / certifications', async () => {
		const client = clientReturning(
			JSON.stringify({
				violations: [
					{ section: 'about', sentence: 'Bio-zertifiziert seit 2020.', reason: 'no such claim in answers' }
				]
			})
		);
		await expect(auditCopy(client, GOOD, ANSWERS)).rejects.toThrow(/Bio-zertifiziert/);
	});

	it('fails loud when the audit itself returns unparseable output', async () => {
		const client = clientReturning('cannot say');
		await expect(auditCopy(client, GOOD, ANSWERS)).rejects.toThrow(/JSON/i);
	});
});
