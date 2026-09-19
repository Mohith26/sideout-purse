import { describe, expect, it } from 'vitest';

import {
  assertRegistrableDestination,
  checkDestination,
  classifyAddress,
  destinationPolicy,
  hostAsLiteral,
  parseDestination,
  parseIpv4Loose,
  type DestinationPolicy,
  type DestinationRefusal,
  type ResolvedAddress,
} from '../../src/webhooks';
import { isWebhookError } from '../../src/webhooks/errors';

/**
 * The destination table (docs/webhooks-security.md): every class of address Purse refuses
 * to deliver to, every spelling of a literal that hides one, and the accepted public
 * case. No database, no network, no clock — the resolver is a map this test writes.
 */
const PUBLIC_V4 = '93.184.216.34';
const PUBLIC_V6 = '2606:4700:4700::1111';

function policyWith(answers: Record<string, ResolvedAddress[]>, overrides: Partial<DestinationPolicy> = {}): DestinationPolicy {
  return destinationPolicy(
    { nodeEnv: 'test' },
    {
      resolve: (host) => {
        const answer = answers[host];
        return answer === undefined ? Promise.reject(new Error(`no answer for ${host}`)) : Promise.resolve(answer);
      },
      ...overrides,
    },
  );
}

const PUBLIC_ONLY = policyWith({ 'hooks.example': [{ address: PUBLIC_V4, family: 4 }] });

/** The refusal reason a call produced, or `null` when it was accepted. */
async function refusalOf(url: string, policy: DestinationPolicy = PUBLIC_ONLY): Promise<DestinationRefusal | null> {
  try {
    await checkDestination(url, policy);
    return null;
  } catch (error) {
    if (!isWebhookError(error, 'url_not_allowed')) throw error;
    return error.detail['reason'] as DestinationRefusal;
  }
}

describe('webhook destination validation', () => {
  it('accepts a public https destination and hands back the address to pin', async () => {
    const checked = await checkDestination('https://hooks.example/purse?x=1', PUBLIC_ONLY);
    expect(checked.host).toBe('hooks.example');
    expect(checked.address).toEqual({ address: PUBLIC_V4, family: 4 });
    expect(checked.url.toString()).toBe('https://hooks.example/purse?x=1');
  });

  it('accepts a public IPv6 literal and a public IPv4 literal', async () => {
    expect((await checkDestination(`https://[${PUBLIC_V6}]/hooks`, PUBLIC_ONLY)).address).toEqual({ address: PUBLIC_V6, family: 6 });
    expect((await checkDestination(`https://${PUBLIC_V4}/hooks`, PUBLIC_ONLY)).address).toEqual({ address: PUBLIC_V4, family: 4 });
  });

  it('refuses a non-absolute, whitespace-carrying or over-long url', async () => {
    expect(await refusalOf('/hooks')).toBe('not_absolute');
    expect(await refusalOf('hooks.example/purse')).toBe('not_absolute');
    expect(await refusalOf('https://hooks.example/a b')).toBe('not_absolute');
    expect(await refusalOf(`https://hooks.example/${'a'.repeat(2100)}`)).toBe('too_long');
  });

  it('refuses a scheme that is not http(s), and plain http outside development', async () => {
    expect(await refusalOf('ftp://hooks.example/purse')).toBe('scheme_not_allowed');
    expect(await refusalOf('file:///etc/passwd')).toBe('scheme_not_allowed');
    // `test` is a development environment, so plain http is accepted there…
    expect(await refusalOf('http://hooks.example/purse')).toBeNull();
    // …and never in production.
    const production = policyWith({ 'hooks.example': [{ address: PUBLIC_V4, family: 4 }] }, { allowHttp: false });
    expect(await refusalOf('http://hooks.example/purse', production)).toBe('insecure_scheme');
    expect(await refusalOf('https://hooks.example/purse', production)).toBeNull();
  });

  it('refuses credentials and a fragment', async () => {
    expect(await refusalOf('https://user:pw@hooks.example/purse')).toBe('credentials_present');
    expect(await refusalOf('https://user@hooks.example/purse')).toBe('credentials_present');
    expect(await refusalOf('https://hooks.example/purse#frag')).toBe('fragment_present');
    expect(await refusalOf('https://hooks.example/purse#')).toBeNull();
  });

  it('allows every port by default and only the named ones when the deployment says so', async () => {
    expect(await refusalOf('https://hooks.example:8443/purse')).toBeNull();
    const narrow = policyWith({ 'hooks.example': [{ address: PUBLIC_V4, family: 4 }] }, { allowedPorts: new Set([443]) });
    expect(await refusalOf('https://hooks.example/purse', narrow)).toBeNull();
    expect(await refusalOf('https://hooks.example:8443/purse', narrow)).toBe('port_not_allowed');
  });

  it('refuses every non-public IPv4 range written as a literal', async () => {
    const table: Array<[string, DestinationRefusal]> = [
      ['127.0.0.1', 'loopback_address'],
      ['127.9.9.9', 'loopback_address'],
      ['10.1.2.3', 'private_address'],
      ['172.16.0.1', 'private_address'],
      ['172.31.255.255', 'private_address'],
      ['192.168.0.1', 'private_address'],
      ['169.254.169.254', 'link_local_address'],
      ['100.64.0.1', 'reserved_address'],
      ['192.0.2.1', 'reserved_address'],
      ['198.18.0.1', 'reserved_address'],
      ['198.51.100.1', 'reserved_address'],
      ['203.0.113.1', 'reserved_address'],
      ['224.0.0.1', 'multicast_address'],
      ['240.0.0.1', 'reserved_address'],
      ['255.255.255.255', 'reserved_address'],
      ['0.0.0.0', 'unspecified_address'],
    ];
    for (const [address, reason] of table) expect(await refusalOf(`https://${address}/hooks`), address).toBe(reason);
    // 172.32/16 is outside the private block and stays public.
    expect(await refusalOf('https://172.32.0.1/hooks')).toBeNull();
  });

  it('refuses every non-public IPv6 range written as a literal, including IPv4-mapped', async () => {
    const table: Array<[string, DestinationRefusal]> = [
      ['::1', 'loopback_address'],
      ['::', 'unspecified_address'],
      ['fe80::1', 'link_local_address'],
      ['fc00::1', 'unique_local_address'],
      ['fd12:3456::1', 'unique_local_address'],
      ['ff02::1', 'multicast_address'],
      ['2001:db8::1', 'reserved_address'],
      ['2001::1', 'reserved_address'],
      ['2002::1', 'reserved_address'],
      ['64:ff9b::7f00:1', 'reserved_address'],
      ['100::1', 'reserved_address'],
      ['fec0::1', 'reserved_address'],
      ['::ffff:127.0.0.1', 'ipv4_mapped_address'],
      // Even a public IPv4 wrapped in the mapped form is refused: it must be written plainly.
      ['::ffff:93.184.216.34', 'ipv4_mapped_address'],
      ['::7f00:1', 'reserved_address'],
    ];
    for (const [address, reason] of table) expect(await refusalOf(`https://[${address}]/hooks`), address).toBe(reason);
  });

  it('sees through the decimal, octal, hexadecimal and short spellings of a literal', async () => {
    for (const spelling of ['2130706433', '0177.0.0.1', '0x7f000001', '0x7f.0x0.0x0.0x1', '127.1', '127.0.1', '017700000001']) {
      expect(await refusalOf(`https://${spelling}/hooks`), spelling).toBe('loopback_address');
    }
    // The same spellings of a private address, and of the cloud metadata service.
    expect(await refusalOf('https://2851995648/hooks')).toBe('link_local_address'); // 169.254.169.254
    expect(await refusalOf('https://0xa000001/hooks')).toBe('private_address'); // 10.0.0.1
    expect(parseIpv4Loose('2130706433')).toBe('127.0.0.1');
    expect(parseIpv4Loose('010.010.010.010')).toBe('8.8.8.8');
    expect(parseIpv4Loose('hooks.example')).toBeNull();
    expect(hostAsLiteral('hooks.example')).toBeNull();
    expect(hostAsLiteral('127.1')).toEqual({ address: '127.0.0.1', family: 4 });
  });

  it('refuses a hostname whose answer is private, and refuses the whole set when one answer is', async () => {
    const rebinding = policyWith({
      'evil.example': [{ address: '127.0.0.1', family: 4 }],
      'metadata.example': [{ address: '169.254.169.254', family: 4 }],
      'mixed.example': [
        { address: PUBLIC_V4, family: 4 },
        { address: '10.0.0.5', family: 4 },
      ],
      'mapped.example': [{ address: '::ffff:10.0.0.7', family: 6 }],
      'good.example': [
        { address: PUBLIC_V4, family: 4 },
        { address: PUBLIC_V6, family: 6 },
      ],
    });
    expect(await refusalOf('https://evil.example/hooks', rebinding)).toBe('loopback_address');
    expect(await refusalOf('https://metadata.example/hooks', rebinding)).toBe('link_local_address');
    expect(await refusalOf('https://mixed.example/hooks', rebinding)).toBe('private_address');
    // A resolver that answers in the IPv4-mapped form is judged on the IPv4 it carries.
    expect(await refusalOf('https://mapped.example/hooks', rebinding)).toBe('private_address');
    expect(await refusalOf('https://good.example/hooks', rebinding)).toBeNull();
    expect((await checkDestination('https://good.example/hooks', rebinding)).address).toEqual({ address: PUBLIC_V4, family: 4 });
  });

  it('refuses an address family it cannot classify', async () => {
    const odd = policyWith({ 'odd.example': [{ address: 'not-an-address', family: 4 }] });
    expect(await refusalOf('https://odd.example/hooks', odd)).toBe('unsupported_address_family');
    expect(classifyAddress('not-an-address')).toBe('unknown_family');
  });

  it('treats an unresolvable host as registrable but never as deliverable', async () => {
    const empty = policyWith({ 'empty.example': [] });
    expect(await refusalOf('https://nothing.example/hooks', empty)).toBe('unresolvable');
    expect(await refusalOf('https://empty.example/hooks', empty)).toBe('unresolvable');
    // Registration accepts it: the dispatcher will judge the destination again.
    await expect(assertRegistrableDestination('https://nothing.example/hooks', empty)).resolves.toBeInstanceOf(URL);
    // Anything already refusable stays refused at registration.
    await expect(assertRegistrableDestination('https://127.0.0.1/hooks', empty)).rejects.toThrow(/loopback/);
  });

  it('bounds the resolver: a slow answer is unresolvable, not a hung registration', async () => {
    const slow = policyWith(
      {},
      {
        resolve: () =>
          new Promise<ResolvedAddress[]>((resolve) => {
            const timer = setTimeout(() => resolve([{ address: PUBLIC_V4, family: 4 }]), 5000);
            timer.unref();
          }),
        resolveTimeoutMs: 20,
      },
    );
    const started = Date.now();
    expect(await refusalOf('https://slow.example/hooks', slow)).toBe('unresolvable');
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('honours the escape hatch for the named hosts only, and never for the scheme in production', async () => {
    const answers = { localhost: [{ address: '127.0.0.1', family: 4 as const }], 'other.example': [{ address: '127.0.0.1', family: 4 as const }] };
    const development = policyWith(answers, { allowedHosts: new Set(['localhost']) });
    const checked = await checkDestination('http://localhost:4300/hooks', development);
    expect(checked.address).toEqual({ address: '127.0.0.1', family: 4 });
    // A host that is not on the list is judged as usual, however it resolves.
    expect(await refusalOf('http://other.example/hooks', development)).toBe('loopback_address');
    // An allowlisted literal is exempt too.
    const literal = policyWith(answers, { allowedHosts: new Set(['127.0.0.1']) });
    expect(await refusalOf('http://127.0.0.1:4300/hooks', literal)).toBeNull();
    // In production the allowlist still cannot buy plain http.
    const production = policyWith(answers, { allowedHosts: new Set(['localhost']), allowHttp: false });
    expect(await refusalOf('http://localhost:4300/hooks', production)).toBe('insecure_scheme');
    expect(await refusalOf('https://localhost:4300/hooks', production)).toBeNull();
  });

  it('is empty by default, so nothing is exempt unless a deployment named it', () => {
    const fresh = destinationPolicy({ nodeEnv: 'production' });
    expect(fresh.allowedHosts.size).toBe(0);
    expect(fresh.allowedPorts.size).toBe(0);
    expect(fresh.allowHttp).toBe(false);
    expect(destinationPolicy({ nodeEnv: 'development' }).allowHttp).toBe(true);
    expect(() => parseDestination('https://127.0.0.1/hooks', fresh)).toThrow(/loopback/);
  });
});
