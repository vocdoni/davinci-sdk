import { UrlPolicyError, checkPublicUrl } from '../../../src/core/download';

// The sequencer's `is_public` table (sequencer/src/census.rs) plus the forms a URL parser
// rewrites to the same address.
const PRIVATE_HOSTS = [
  '10.0.0.1',
  '192.168.1.1',
  '172.16.0.1',
  '172.31.255.255',
  '169.254.169.254',
  '100.64.0.1',
  '100.127.255.255',
  '0.1.2.3',
  '0.0.0.0',
  '127.0.0.1',
  '127.255.255.255',
  '240.0.0.1',
  '255.255.255.255',
  '224.0.0.1',
  '192.0.0.1',
  '192.0.2.1',
  '198.18.0.1',
  '198.19.255.255',
  '198.51.100.1',
  '203.0.113.1',
  '[fd00::1]',
  '[fe80::1]',
  '[fec0::1]',
  '[::ffff:127.0.0.1]',
  '[::ffff:10.0.0.1]',
  '[::ffff:0:127.0.0.1]',
  '[::ffff:0:10.0.0.1]',
  '[::127.0.0.1]',
  '[::10.1.2.3]',
  '[64:ff9b::1.1.1.1]',
  '[64:ff9b:1::1]',
  '[2002:c0a8:0101::1]',
  '[2001:db8::1]',
  '[2001:0:4136:e378::1]',
  '[::]',
  '[::1]',
  '[ff02::1]',
  'localhost',
  'LOCALHOST',
  'foo.localhost',
  // Spellings the URL parser turns into 127.0.0.1.
  '2130706433',
  '0x7f.1',
  '0177.0.0.1',
  '127.1',
];
const PUBLIC_HOSTS = [
  '1.1.1.1',
  '8.8.8.8',
  '198.17.255.255',
  '198.20.0.1',
  '192.0.1.1',
  '[2606:4700::1111]',
  '[::ffff:1.1.1.1]',
  'example.org',
];

// BUG: the SDK policy accepts 192.0.0.0/24, 198.18.0.0/15, fec0::/10 and ::ffff:0:a.b.c.d, which the nodes refuse.
describe('attack: the document URL policy matches the nodes', () => {
  for (const h of PRIVATE_HOSTS) {
    it(`refuses http://${h}/`, () => {
      expect(() => checkPublicUrl(`http://${h}/census.json`)).toThrow(UrlPolicyError);
    });
  }
  for (const h of PUBLIC_HOSTS) {
    it(`accepts https://${h}/`, () => {
      expect(() => checkPublicUrl(`https://${h}/census.json`)).not.toThrow();
    });
  }

  // BUG: a trailing dot ("localhost.") is the same host and passes the name check.
  it('refuses localhost with a trailing dot', () => {
    expect(() => checkPublicUrl('http://localhost./x')).toThrow(UrlPolicyError);
    expect(() => checkPublicUrl('http://foo.localhost./x')).toThrow(UrlPolicyError);
  });

  it('refuses other schemes and userinfo tricks to a private host', () => {
    for (const u of [
      'file:///etc/passwd',
      'ftp://example.org/x',
      'javascript:alert(1)',
      'data:text/plain,hi',
      'ipfs://Qm',
      'not a url',
      '',
    ]) {
      expect(() => checkPublicUrl(u)).toThrow(UrlPolicyError);
    }
    expect(() => checkPublicUrl('http://example.org@127.0.0.1/')).toThrow(UrlPolicyError);
    expect(() => checkPublicUrl('http://127.0.0.1:80@example.org/')).not.toThrow();
  });

  it('allowPrivateHosts opens private hosts but not other schemes', () => {
    expect(() => checkPublicUrl('http://127.0.0.1/', { allowPrivateHosts: true })).not.toThrow();
    expect(() => checkPublicUrl('file:///x', { allowPrivateHosts: true })).toThrow(UrlPolicyError);
  });
});
