import { describe, expect, it } from 'vitest'
import { API_KEY_ROUTES, isApiKeyRoute, parseBearerApiKey } from './bearer-routes'

describe('isApiKeyRoute', () => {
  it('accepts exactly the routes built for API keys', () => {
    expect(API_KEY_ROUTES).toEqual(['/api/mcp', '/api/mail/send'])
    for (const route of API_KEY_ROUTES) expect(isApiKeyRoute(route)).toBe(true)
  })

  it('accepts sub-paths of an allowed route', () => {
    expect(isApiKeyRoute('/api/mcp/')).toBe(true)
    expect(isApiKeyRoute('/api/mcp/sse')).toBe(true)
  })

  it('denies every other API route, so a key can never act as the owner there', () => {
    for (const path of [
      '/api/keys',
      '/api/keys/abc',
      '/api/thoughts/export',
      '/api/memory/export',
      '/api/memories',
      '/api/chat',
      '/api/admin/queue',
      '/api/approvals/mode',
      '/api/mail',
      '/api/mail/send-later',
      '/api/mcpx',
      '/api',
    ]) {
      expect(isApiKeyRoute(path), path).toBe(false)
    }
  })

  it('denies pages and the root, so a key never opens the console', () => {
    for (const path of ['/', '/login', '/overview', '/m/website/apps/site', '/api-keys']) {
      expect(isApiKeyRoute(path), path).toBe(false)
    }
  })

  it('is case-sensitive and takes a pathname, never a full URL', () => {
    expect(isApiKeyRoute('/API/MCP')).toBe(false)
    expect(isApiKeyRoute('/api/mcp?x=1')).toBe(false)
    expect(isApiKeyRoute('https://host/api/mcp')).toBe(false)
  })
})

describe('parseBearerApiKey', () => {
  it('returns the key from a Bearer header, scheme case-insensitive', () => {
    expect(parseBearerApiKey('Bearer eigen_0123abcdef')).toBe('eigen_0123abcdef')
    expect(parseBearerApiKey('bearer eigen_0123abcdef')).toBe('eigen_0123abcdef')
    expect(parseBearerApiKey('Bearer   eigen_ff')).toBe('eigen_ff')
  })

  it('returns null when there is no usable key', () => {
    for (const header of [
      null,
      '',
      'Bearer',
      'Bearer ',
      'Basic eigen_0123',
      'Bearer notakey',
      'Bearer eigen_',
      'Bearer eigen_xyz',
      'Bearer eigen_0123 extra',
      'eigen_0123',
    ]) {
      expect(parseBearerApiKey(header), String(header)).toBeNull()
    }
  })
})
