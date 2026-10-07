/**
 * The website module — the first module (phase-wedge M3, P2/P3).
 *
 * performRender is the whole pipeline, code-owned end to end:
 *   answers → draftCopy (LLM, answers only) → auditCopy (W5 hard filter)
 *   → renderHtml (typographic template) → git commit (site store).
 * A rejected audit commits NOTHING; a successful render commits EVERYTHING.
 *
 * The model's only job is calling render_website at ready_to_render and
 * speaking the reveal afterwards. Meaning stays with the LLM; the agenda
 * stays with code.
 */

import moduleJsonRaw from './module.json?raw';
import themeCssRaw from './theme.css?raw';
import type { LlmClient } from '../../src/lib/server/llm.ts';
import type { ToolDef, ToolContext } from '../../src/lib/server/tools.ts';
import { ToolError } from '../../src/lib/server/tools.ts';
import type { MemoryStore } from '../../src/lib/server/memory.ts';
import { renderSiteCommit, siteDirFor } from '../../src/lib/server/site-store.ts';
import { CONTENT_SCHEMA, SECTION_TYPES, auditCopy, draftCopy } from './copy.ts';
import type { AnswerMap } from './copy.ts';
import { renderHtml } from './template.ts';

/** Mirrors modules/website/module.json — kept in sync by test, not hope. */
export interface WebsiteManifest {
	name: string;
	version: string;
	description: string;
	content: { schema: string; sectionTypes: string[] };
	theme: { file: string; tokens: string[] };
	tools: { name: string; haltsTurn?: boolean }[];
}

export function websiteManifest(): WebsiteManifest {
	// The manifest and theme ship INSIDE the bundle (?raw import) — no runtime
	// fs reads, so the production build cannot lose them (e2e caught exactly
	// that: import.meta.dirname dies in the bundled server).
	const raw: unknown = JSON.parse(moduleJsonRaw);
	const manifest = raw as WebsiteManifest;
	if (manifest.name !== 'website') {
		throw new Error(`website module.json: expected name "website" — got ${JSON.stringify(manifest.name)}.`);
	}
	if (manifest.content?.schema !== CONTENT_SCHEMA) {
		throw new Error(
			`website module.json: content.schema must be "${CONTENT_SCHEMA}" — got ${JSON.stringify(manifest.content?.schema)}.`
		);
	}
	if (JSON.stringify(manifest.content?.sectionTypes) !== JSON.stringify([...SECTION_TYPES])) {
		throw new Error(
			`website module.json: content.sectionTypes must be [${SECTION_TYPES.join(', ')}] — got ${JSON.stringify(
				manifest.content?.sectionTypes
			)}.`
		);
	}
	if (!manifest.tools?.some((t) => t.name === 'render_website')) {
		throw new Error('website module.json: the render_website tool must be declared.');
	}
	return manifest;
}

export function defaultThemeCss(): string {
	return themeCssRaw;
}

export interface PerformRenderDeps {
	client: LlmClient;
	memory: MemoryStore;
	sitesDir: string;
}

export interface RenderResult {
	company: string;
	version: string;
	commit: string;
	previewPath: '/site';
	files: Record<string, string>;
}

export async function performRender(deps: PerformRenderDeps): Promise<RenderResult> {
	const answers: AnswerMap = {};
	for (const entry of await deps.memory.latest()) {
		if (entry.kind === 'answer') answers[entry.key] = entry.value;
	}
	const company = answers['company.name'];
	if (!company) {
		throw new ToolError(
			'render_website: company.name was never answered — the interview is not complete, so there is nothing to render.'
		);
	}

	const content = await draftCopy(deps.client, answers);
	// The W5 hard filter — throws before anything is written when the draft
	// states things the founder never said.
	await auditCopy(deps.client, content, answers);

	const themeCss = defaultThemeCss();
	const files: Record<string, string> = {
		'index.html': renderHtml(content, { themeCss }),
		// Provenance travels with the copy: every section carries its source answers.
		'content.json': `${JSON.stringify(content, null, 2)}\n`,
		'theme.css': themeCss
	};
	// The directory follows the audited draft's clean company name — the same
	// name the site itself renders (the founder's raw answer can be a sentence).
	const { version, commit } = renderSiteCommit(siteDirFor(deps.sitesDir, content.company.name), files);
	// `company` is the audited draft name — the SAME name the directory, the
	// render record and the rendered site use. The raw founder answer can be a
	// sentence ("Hafenlicht — ein kleines Fotostudio…"); it is input, not identity.
	return { company: content.company.name, version, commit, previewPath: '/site', files };
}

export interface RenderWebsiteToolDeps {
	client: LlmClient;
	/** Resolves at call time — required, fail loud (same convention as the LLM config). */
	getSitesDir(): string;
}

interface WebsiteToolContext extends ToolContext {
	memory: MemoryStore;
}

export function renderWebsiteTool(deps: RenderWebsiteToolDeps): ToolDef<WebsiteToolContext> {
	return {
		name: 'render_website',
		description:
			'Build and commit the founder\'s website from their interview answers: the copy is drafted in their voice, ' +
			'audited against invention, rendered and committed as the first version. Call this ONLY when the process ' +
			'state says ready_to_render. Takes no arguments. After it succeeds, deliver the reveal: the preview path ' +
			'and one short question about what stands out — then stop talking.',
		parameters: { type: 'object', properties: {}, additionalProperties: false },
		haltsTurn: false,
		execute: async (_args, ctx) => {
			const result = await performRender({
				client: deps.client,
				memory: ctx.memory,
				sitesDir: deps.getSitesDir()
			});
			// The render is memory, not hidden state — the process phase derives
			// from it (plan.ts), so resume after a crash stays exact.
			await ctx.memory.remember({
				kind: 'render',
				key: 'website',
				value: JSON.stringify({ company: result.company, version: result.version, commit: result.commit })
			});
			return {
				rendered: true,
				company: result.company,
				version: result.version,
				commit: result.commit,
				previewPath: result.previewPath,
				next: `Reveal it now: tell the founder their website is at ${result.previewPath} (version ${result.version}) and ask what stands out. Do not give a tour. Do not list features.`
			};
		}
	};
}
