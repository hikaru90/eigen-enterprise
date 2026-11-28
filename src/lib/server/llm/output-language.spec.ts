import { describe, expect, it } from 'vitest'
import { assertOutputScript, languageName, OutputScriptError, outputLanguageInstruction } from './output-language'

describe('outputLanguageInstruction', () => {
  it('names the language in English words', () => {
    expect(outputLanguageInstruction('de')).toContain('German')
    expect(outputLanguageInstruction('en')).toContain('English')
  })
  it('an unknown language code fails loud', () => {
    expect(() => languageName('')).toThrow()
  })
})

describe('assertOutputScript (wish d0a0c775: no stray Chinese characters in summaries)', () => {
  it('passes Latin text with accents, digits, punctuation and emoji', () => {
    expect(assertOutputScript('Über die Straße — 3× „Ja“ ✅ café', { language: 'de', what: 'recap' })).toBe('Über die Straße — 3× „Ja“ ✅ café')
  })
  it('refuses Han characters in an English summary, naming the script and a sample', () => {
    const call = () => assertOutputScript('- Discussed pricing 定价 for Q1', { language: 'en', what: 'call recap' })
    expect(call).toThrow(OutputScriptError)
    expect(call).toThrow(/call recap.*Han.*English/)
    try {
      call()
    } catch (err) {
      expect((err as OutputScriptError).scripts).toEqual(['Han'])
      expect((err as OutputScriptError).sample).toContain('定价')
    }
  })
  it('refuses Hangul, Cyrillic and Hiragana the same way', () => {
    for (const t of ['안녕', 'привет', 'ありがとう']) {
      expect(() => assertOutputScript(`ok ${t}`, { language: 'en', what: 'summary' })).toThrow(OutputScriptError)
    }
  })
  it('allows a foreign script that the source itself contains (a name as written)', () => {
    expect(assertOutputScript('Met 王伟 about pricing', { language: 'en', what: 'recap', source: 'Speaker 王伟: pricing' })).toBe('Met 王伟 about pricing')
  })
  it('a Chinese-language company writes Han', () => {
    expect(assertOutputScript('讨论了定价', { language: 'zh', what: 'recap' })).toBe('讨论了定价')
  })
})
