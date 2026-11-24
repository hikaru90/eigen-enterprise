/**
 * Third-party credentials operators must supply after install — never ship in .env.example
 * or bake into open-source defaults.
 */
export const OSS_OPERATOR_SECRET_KEYS = [
  'SERVICE_API_KEY_EUROUTER',
  'SERVICE_API_KEY_OPENROUTER',
  'LLM_API_KEY',
  'OPENROUTER_API_KEY',
  'PAYPAL_CLIENT_ID',
  'PAYPAL_CLIENT_SECRET',
  'PAYPAL_SECRET',
  'POSTHOG_API_KEY',
  'POSTHOG_CLI_API_KEY',
  'POSTHOG_PERSONAL_API_KEY',
  'PUBLIC_POSTHOG_KEY',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'GITHUB_CLIENT_ID',
  'GITHUB_CLIENT_SECRET',
  'PAYPAL_SANDBOX_BUYER_EMAIL',
  'PAYPAL_SANDBOX_BUYER_PASSWORD',
  'OWLERY_API_KEY',
]

/** Patterns that must not appear in tracked OSS files (real key material). */
export const OSS_FORBIDDEN_KEY_PATTERNS = [
  /\bphx_[a-zA-Z0-9]{20,}\b/,
  /\bphc_[a-zA-Z0-9]{20,}\b/,
  /\bsk-or-[a-zA-Z0-9]{20,}\b/,
  /\bsk-[a-zA-Z0-9]{20,}\b/,
]

/**
 * @param {string} line
 * @returns {string}
 */
export function parseEnvExampleValue(line) {
  const match = line.match(/^[^=]+=\s*(.*)$/)
  if (!match) return ''
  let raw = match[1].trim()
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    raw = raw.slice(1, -1)
  }
  return raw.trim()
}

/** A PEM private-key header (PKCS#8, RSA, EC, OPENSSH, ENCRYPTED …). */
const PEM_PRIVATE_KEY_HEADER = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/

/** @param {string} s */
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Per operator key: a dotenv line (`KEY=value`, `export KEY=value`) and a
 * quoted assignment in code or config (`KEY: "value"`, `"KEY": "value"`,
 * `KEY = 'value'`).
 * @type {{ key: string, dotenv: RegExp, quoted: RegExp }[]}
 */
const OPERATOR_KEY_ASSIGNMENTS = OSS_OPERATOR_SECRET_KEYS.map((key) => ({
  key,
  dotenv: new RegExp(`^\\s*(?:export\\s+)?${escapeRegExp(key)}\\s*=`),
  quoted: new RegExp(`\\b${escapeRegExp(key)}\\b["']?\\s*[:=]\\s*(["'\`])((?:(?!\\1).)*)\\1`, 'g'),
}))

/**
 * @typedef {{ line: number, rule: 'credential' | 'private_key' | 'operator_key', message: string }} SecretFinding
 */

/**
 * The secret scan over one text (plan/phase-upgrades-u2.md §6.2 check 6; the
 * OSS gate below uses it too): the credential-format patterns, PEM private-key
 * headers, and non-empty assignments to an operator secret key. A finding
 * names the line (1-based) and the rule — never the matched value, so a
 * finding can be shown and logged as is.
 * @param {string} text
 * @returns {SecretFinding[]}
 */
export function scanSecrets(text) {
  /** @type {SecretFinding[]} */
  const findings = []
  for (const [i, raw] of text.split('\n').entries()) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    const n = i + 1
    for (const pattern of OSS_FORBIDDEN_KEY_PATTERNS) {
      if (pattern.test(line)) findings.push({ line: n, rule: 'credential', message: `a credential matching ${pattern}` })
    }
    if (PEM_PRIVATE_KEY_HEADER.test(line)) findings.push({ line: n, rule: 'private_key', message: 'a PEM private key' })
    for (const { key, dotenv, quoted } of OPERATOR_KEY_ASSIGNMENTS) {
      const assigned =
        (dotenv.test(line) && parseEnvExampleValue(line) !== '') ||
        [...line.matchAll(quoted)].some((m) => (m[2] ?? '').trim() !== '')
      if (assigned) findings.push({ line: n, rule: 'operator_key', message: `a value assigned to ${key}` })
    }
  }
  return findings
}
