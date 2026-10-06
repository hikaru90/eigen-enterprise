/**
 * Postgres connection for the slice. Decision W2: Postgres only.
 * The URL is required from env — no defaults, fail loud (no-fallbacks rule).
 */

import postgres from 'postgres';

export type Sql = postgres.Sql;

export function databaseUrlFromEnv(env: NodeJS.ProcessEnv = process.env): string {
	const url = env.COMPANY_OS_DATABASE_URL;
	if (!url) {
		throw new Error(
			'COMPANY_OS_DATABASE_URL is required (e.g. postgres://user:pass@host:5432/company_os). Set it and retry — the OS does not guess.'
		);
	}
	return url;
}

export function connect(url: string): Sql {
	return postgres(url, {
		// `create table if not exists` notices are expected in the migrate path — noise otherwise
		onnotice: () => {}
	});
}
