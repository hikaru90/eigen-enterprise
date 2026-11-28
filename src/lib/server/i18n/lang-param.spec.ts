import { describe, expect, it, vi } from 'vitest'
import { applyLangParam } from './lang-param'

vi.mock('$lib/paraglide/runtime', () => ({ cookieName: 'PARAGLIDE_LOCALE', cookieMaxAge: 31_536_000, locales: ['en', 'de'] }))

const cookies = () => ({ set: vi.fn() })

describe('applyLangParam (?lang= on the entry pages: the website links the demo in its own language)', () => {
  it('without ?lang= nothing happens', () => {
    const c = cookies()
    expect(() => applyLangParam(new URL('https://demo.example/login?team=1'), c as never)).not.toThrow()
    expect(c.set).not.toHaveBeenCalled()
  })

  it('?lang=de sets the UI language cookie and reloads the same page without the parameter', () => {
    const c = cookies()
    let thrown: unknown
    try {
      applyLangParam(new URL('https://demo.example/login?lang=de&team=1'), c as never)
    } catch (err) {
      thrown = err
    }
    expect(thrown).toMatchObject({ status: 303, location: '/login?team=1' })
    expect(c.set).toHaveBeenCalledWith('PARAGLIDE_LOCALE', 'de', expect.objectContaining({ path: '/', sameSite: 'lax', httpOnly: false }))
  })

  it('an unknown language is refused plainly', () => {
    const c = cookies()
    expect(() => applyLangParam(new URL('https://demo.example/login?lang=fr'), c as never)).toThrow(expect.objectContaining({ status: 400 }))
    expect(c.set).not.toHaveBeenCalled()
  })
})
