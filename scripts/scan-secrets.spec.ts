import { describe, expect, it } from 'vitest'
import { scanSecrets } from './oss-operator-secret-keys.mjs'

// Planted values are built at runtime so this file itself never holds one
// (assert-oss-no-secrets scans every tracked file).
const SK = ['sk', 'a1B2c3D4e5F6g7H8i9J0kLmN'].join('-')
const PEM = ['-----BEGIN', 'RSA PRIVATE KEY-----'].join(' ')

describe('scanSecrets', () => {
  it('finds a credential format, a PEM private key and an operator key assignment, by line and rule', () => {
    const text = ['const ok = 1', `const key = "${SK}"`, PEM, 'LLM_API_KEY=abc123', `config = { LLM_API_KEY: 'v' }`].join('\n')
    expect(scanSecrets(text).map((f) => [f.line, f.rule])).toEqual([
      [2, 'credential'],
      [3, 'private_key'],
      [4, 'operator_key'],
      [5, 'operator_key'],
    ])
  })

  it('never puts the value into a finding', () => {
    const findings = scanSecrets(`token = "${SK}"\nLLM_API_KEY="hunter2-value"`)
    expect(findings).toHaveLength(2)
    for (const f of findings) {
      expect(f.message).not.toContain(SK)
      expect(f.message).not.toContain('hunter2')
    }
  })

  it('leaves empty assignments, references and ordinary text alone', () => {
    const text = [
      'LLM_API_KEY=',
      'LLM_API_KEY=""',
      'export const LLM_API_KEY = ""',
      'const key = process.env.LLM_API_KEY',
      'the sk- prefix is short here: sk-abc',
      '-----BEGIN PUBLIC KEY-----',
    ].join('\n')
    expect(scanSecrets(text)).toEqual([])
  })

  it('counts lines across CRLF line ends', () => {
    expect(scanSecrets(`a\r\nb\r\nx = "${SK}"\r\n`).map((f) => f.line)).toEqual([3])
  })
})
