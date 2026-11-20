import { describe, expect, it } from 'vitest'
import { ensurePreviewNet, forwarderScript, nftRuleset, parseResolvers, PREVIEW_RESOLV } from './preview-net.ts'
import { PreviewBox } from './preview-test-box.ts'

describe('preview network (isolation for Drive app previews)', () => {
  it('takes IPv4 nameservers from resolv.conf, never loopback stubs', () => {
    expect(parseResolvers('# x\nnameserver 127.0.0.53\nnameserver 9.9.9.9\nnameserver 2620:fe::fe\nnameserver 192.168.65.7\nnameserver 9.9.9.9\n')).toEqual(['9.9.9.9', '192.168.65.7'])
    expect(parseResolvers('nameserver 127.0.0.53\noptions edns0\n')).toEqual([])
  })

  it('the nft table: the link reaches DNS and the internet, never the box or private ranges; forwarding is closed otherwise', () => {
    const r = nftRuleset(['192.168.65.7'])
    // Idempotent atomic replace.
    expect(r.startsWith('table inet ee_preview {}\ndelete table inet ee_preview\n')).toBe(true)
    // The box itself: replies only.
    expect(r).toContain('iifname "ee-pv0" ct state established,related accept')
    expect(r).toContain('iifname "ee-pv0" drop')
    // DNS to the box's resolvers first, then private ranges dropped, then the internet.
    const dns = r.indexOf('ip daddr { 192.168.65.7 } meta l4proto { udp, tcp } th dport 53 accept')
    const priv = r.indexOf('ip daddr { 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16, 100.64.0.0/10, 127.0.0.0/8 } drop')
    const out = r.indexOf('iifname "ee-pv0" meta nfproto ipv4 accept')
    expect(dns).toBeGreaterThan(0)
    expect(priv).toBeGreaterThan(dns)
    expect(out).toBeGreaterThan(priv)
    expect(r).toContain('type filter hook forward priority -10; policy drop;')
    expect(r).toContain('ip saddr 10.237.0.0/30 oifname != "ee-pv0" masquerade')
    expect(() => nftRuleset([])).toThrow(/DNS server/)
  })

  it('creates the namespace and veth pair once, (re)applies addresses, routes, forwarding and the table', async () => {
    const box = new PreviewBox()
    box.files.set('/etc/resolv.conf', 'nameserver 192.168.65.7\n')
    const net = await ensurePreviewNet(box)
    expect(net).toEqual({ resolvConf: PREVIEW_RESOLV, resolvTarget: '/etc/resolv.conf' })
    expect(box.files.get(PREVIEW_RESOLV)).toBe('nameserver 192.168.65.7\n')
    const cmds = box.commands.map((c) => c.join(' '))
    expect(cmds).toContain('ip netns add ee-preview')
    expect(cmds).toContain('ip -n ee-preview route replace default via 10.237.0.1')
    expect(cmds).toContain('sysctl -qw net.ipv4.ip_forward=1')
    expect(cmds).toContain('nft -f -')

    // Already there: no second namespace or link.
    const again = new PreviewBox()
    again.run = async (cmd, args, opts) => {
      if (cmd === 'ip' && args.join(' ') === 'netns list') return { code: 0, stdout: 'ee-preview (id: 0)\n', stderr: '' }
      return PreviewBox.prototype.run.call(again, cmd, args, opts)
    }
    await ensurePreviewNet(again)
    const cmds2 = again.commands.map((c) => c.join(' '))
    expect(cmds2).not.toContain('ip netns add ee-preview')
    expect(cmds2.some((c) => c.startsWith('ip link add'))).toBe(false)
  })

  it('falls back to systemd-resolved upstreams, and fails loud without any DNS server', async () => {
    const box = new PreviewBox()
    box.files.set('/etc/resolv.conf', 'nameserver 127.0.0.53\n')
    box.files.set('/run/systemd/resolve/resolv.conf', 'nameserver 1.1.1.1\n')
    await ensurePreviewNet(box)
    expect(box.files.get(PREVIEW_RESOLV)).toBe('nameserver 1.1.1.1\n')

    const none = new PreviewBox()
    none.files.set('/etc/resolv.conf', 'nameserver 127.0.0.53\n')
    await expect(ensurePreviewNet(none)).rejects.toThrow(/no DNS server for previews/)
  })

  it('the forwarder pipes NS_ADDR:8080 to the dev server, IPv6 brackets stripped', () => {
    expect(forwarderScript({ host: '[::1]', port: 5173 })).toContain('net.connect(5173, "::1")')
    expect(forwarderScript({ host: '127.0.0.1', port: 3000 })).toContain('server.listen(8080, "10.237.0.2")')
  })
})
