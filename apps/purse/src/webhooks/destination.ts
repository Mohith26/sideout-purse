import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';

import { WebhookError } from './errors';

/**
 * Where Purse is willing to POST a webhook (docs/webhooks-security.md).
 *
 * Every tenant-supplied destination passes through here twice: once when it is registered
 * or edited, and once more on every dispatch attempt, because a hostname that answered
 * with a public address at registration can answer with `127.0.0.1` an hour later. The
 * check returns the address it approved and the dispatcher connects to exactly that
 * address (`transport.ts` pins it through a custom `lookup`), so the check and the
 * connection can never disagree — the classic DNS rebinding window.
 *
 * The rules are deliberately conservative: `https` only outside development, no
 * credentials, no fragment, and an address that is public unicast in both families.
 * Everything else — loopback, private, link-local, unique-local, carrier NAT, multicast,
 * documentation and every other reserved range, IPv4-mapped IPv6, and the decimal, octal
 * and hexadecimal spellings of a literal — is refused. A deployment may exempt named
 * hosts with `WEBHOOK_ALLOWED_HOSTS` (empty by default; the local receiver and CI use it).
 *
 * This module is pure apart from the resolver it is handed, so `test/webhooks/destination.test.ts`
 * drives the whole table without a database, a network or a clock.
 */

/** An address the resolver returned, or a literal written into the URL. */
export type ResolvedAddress = { address: string; family: 4 | 6 };

/** What an address is, once classified. Only `public` may be delivered to. */
export type AddressClass =
  | 'public'
  | 'unspecified'
  | 'loopback'
  | 'private'
  | 'link_local'
  | 'unique_local'
  | 'multicast'
  | 'reserved'
  | 'ipv4_mapped'
  | 'unknown_family';

/** Why a destination was refused. The API returns this as `detail.reason`; the resolved address is never returned. */
export type DestinationRefusal =
  | 'not_absolute'
  | 'too_long'
  | 'scheme_not_allowed'
  | 'insecure_scheme'
  | 'credentials_present'
  | 'fragment_present'
  | 'port_not_allowed'
  | 'host_missing'
  | 'unspecified_address'
  | 'loopback_address'
  | 'private_address'
  | 'link_local_address'
  | 'unique_local_address'
  | 'multicast_address'
  | 'reserved_address'
  | 'ipv4_mapped_address'
  | 'unsupported_address_family'
  | 'unresolvable';

const REFUSAL_OF_CLASS: Record<Exclude<AddressClass, 'public'>, DestinationRefusal> = {
  unspecified: 'unspecified_address',
  loopback: 'loopback_address',
  private: 'private_address',
  link_local: 'link_local_address',
  unique_local: 'unique_local_address',
  multicast: 'multicast_address',
  reserved: 'reserved_address',
  ipv4_mapped: 'ipv4_mapped_address',
  unknown_family: 'unsupported_address_family',
};

export const URL_MAX = 2000;

const REFUSAL_MESSAGE: Record<DestinationRefusal, string> = {
  not_absolute: 'url must be an absolute http(s) URL with no whitespace',
  too_long: `url must be at most ${String(URL_MAX)} characters`,
  scheme_not_allowed: 'url must use the https scheme',
  insecure_scheme: 'plain http destinations are accepted only in development',
  credentials_present: 'url must not carry a username or password',
  fragment_present: 'url must not carry a fragment',
  port_not_allowed: 'url uses a port this deployment does not deliver to',
  host_missing: 'url must name a host',
  unspecified_address: 'the destination is the unspecified address',
  loopback_address: 'the destination is a loopback address',
  private_address: 'the destination is a private-network address',
  link_local_address: 'the destination is a link-local address',
  unique_local_address: 'the destination is a unique-local address',
  multicast_address: 'the destination is a multicast address',
  reserved_address: 'the destination is a reserved address',
  ipv4_mapped_address: 'the destination is an IPv4-mapped IPv6 address; write the IPv4 address plainly',
  unsupported_address_family: 'the destination is not a public unicast address',
  unresolvable: 'the destination host could not be resolved',
};

export type DestinationPolicy = {
  /** Plain `http` is accepted only when the app is in development (`NODE_ENV` is not `production`). */
  allowHttp: boolean;
  /** Hosts exempted from address classification, exactly as written and lowercased. Empty by default. */
  allowedHosts: ReadonlySet<string>;
  /** Ports this deployment delivers to; empty means every port, which is the default (docs/webhooks-security.md). */
  allowedPorts: ReadonlySet<number>;
  /** The resolver seam. Defaults to `node:dns`'s `lookup` with `all`. */
  resolve?: (hostname: string) => Promise<ResolvedAddress[]>;
  /** Bound on one resolution; a slower answer is treated as unresolvable. */
  resolveTimeoutMs?: number;
};

/**
 * The policy a process runs with: plain `http` outside production, nothing exempted and
 * every port allowed unless the deployment named some (`WEBHOOK_ALLOWED_HOSTS`,
 * `WEBHOOK_ALLOWED_PORTS` in `src/env.ts`).
 */
export function destinationPolicy(
  input: { nodeEnv: 'development' | 'test' | 'production'; allowedHosts?: readonly string[]; allowedPorts?: readonly number[] },
  overrides: Partial<DestinationPolicy> = {},
): DestinationPolicy {
  return {
    allowHttp: input.nodeEnv !== 'production',
    allowedHosts: new Set((input.allowedHosts ?? []).map((host) => host.toLowerCase().replace(/^\[|\]$/g, ''))),
    allowedPorts: new Set(input.allowedPorts ?? []),
    ...overrides,
  };
}

export type CheckedDestination = {
  url: URL;
  /** The host as written, lowercased and without IPv6 brackets. */
  host: string;
  /** The address the dispatcher must connect to. `null` only when the caller allows an unresolved destination. */
  address: ResolvedAddress | null;
};

export function destinationRefusal(refusal: DestinationRefusal, host: string): WebhookError {
  return new WebhookError('url_not_allowed', `Webhook destination refused: ${REFUSAL_MESSAGE[refusal]}`, { reason: refusal, host });
}

/** The IPv4 literal spellings the WHATWG parser accepts, parsed again here so no parser difference can slip one through. */
export function parseIpv4Loose(input: string): string | null {
  const parts = input.split('.');
  if (parts.length === 0 || parts.length > 4) return null;
  const numbers: number[] = [];
  for (const part of parts) {
    if (part === '') return null;
    let value: number;
    if (/^0[xX][0-9a-fA-F]+$/.test(part)) value = Number.parseInt(part.slice(2), 16);
    else if (/^0[0-7]+$/.test(part)) value = Number.parseInt(part.slice(1), 8);
    else if (/^(0|[1-9][0-9]*)$/.test(part)) value = Number.parseInt(part, 10);
    else return null;
    if (!Number.isSafeInteger(value) || value < 0) return null;
    numbers.push(value);
  }
  // The last part fills the remaining octets: 127.1 is 127.0.0.1, 2130706433 is 127.0.0.1.
  const last = numbers.pop();
  if (last === undefined) return null;
  const width = 4 - numbers.length;
  if (last >= 256 ** width) return null;
  if (numbers.some((value) => value > 255)) return null;
  let packed = last;
  for (let index = numbers.length - 1; index >= 0; index -= 1) packed += (numbers[index] ?? 0) * 256 ** (3 - index);
  return [(packed >>> 24) & 255, (packed >>> 16) & 255, (packed >>> 8) & 255, packed & 255].join('.');
}

function classifyIpv4(address: string): AddressClass {
  const octets = address.split('.').map((part) => Number.parseInt(part, 10));
  const [a = 0, b = 0, c = 0] = octets;
  if (a === 0) return b === 0 && c === 0 && octets[3] === 0 ? 'unspecified' : 'reserved';
  if (a === 127) return 'loopback';
  if (a === 10) return 'private';
  if (a === 172 && b >= 16 && b <= 31) return 'private';
  if (a === 192 && b === 168) return 'private';
  if (a === 169 && b === 254) return 'link_local';
  if (a === 100 && b >= 64 && b <= 127) return 'reserved'; // carrier-grade NAT
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return 'reserved'; // IETF protocol assignments, TEST-NET-1
  if (a === 192 && b === 88 && c === 99) return 'reserved'; // 6to4 relay anycast
  if (a === 198 && (b === 18 || b === 19)) return 'reserved'; // benchmarking
  if (a === 198 && b === 51 && c === 100) return 'reserved'; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return 'reserved'; // TEST-NET-3
  if (a >= 224 && a <= 239) return 'multicast';
  if (a >= 240) return 'reserved'; // future use, including the broadcast address
  return 'public';
}

/** The sixteen bytes of an IPv6 literal, or null when it is not one. */
export function ipv6Bytes(address: string): Uint8Array | null {
  if (isIP(address) !== 6) return null;
  const [head, tail] = address.includes('::') ? address.split('::', 2) : [address, undefined];
  const expand = (part: string | undefined): string[] => (part === undefined || part === '' ? [] : part.split(':'));
  const groups = [...expand(head), ...(tail === undefined ? [] : ['::']), ...expand(tail)];
  const bytes = new Uint8Array(16);
  const left: number[] = [];
  const right: number[] = [];
  let side = left;
  for (const group of groups) {
    if (group === '::') {
      side = right;
      continue;
    }
    if (group.includes('.')) {
      // A trailing dotted quad, as in ::ffff:127.0.0.1.
      for (const octet of group.split('.')) side.push(Number.parseInt(octet, 10));
      continue;
    }
    const value = Number.parseInt(group, 16);
    side.push((value >> 8) & 255, value & 255);
  }
  if (left.length + right.length > 16) return null;
  bytes.set(left, 0);
  bytes.set(right, 16 - right.length);
  return bytes;
}

function classifyIpv6(address: string, literal: boolean): AddressClass {
  const bytes = ipv6Bytes(address);
  if (bytes === null) return 'unknown_family';
  const [b0 = 0, b1 = 0, b2 = 0, b3 = 0] = bytes;
  const zeroPrefix = (length: number): boolean => bytes.slice(0, length).every((byte) => byte === 0);
  if (zeroPrefix(16)) return 'unspecified';
  if (zeroPrefix(15) && bytes[15] === 1) return 'loopback';
  if (zeroPrefix(10) && bytes[10] === 0xff && bytes[11] === 0xff) {
    // ::ffff:0:0/96. A literal is always refused; a resolver's answer is judged on the IPv4 it carries.
    const embedded = `${String(bytes[12])}.${String(bytes[13])}.${String(bytes[14])}.${String(bytes[15])}`;
    return literal ? 'ipv4_mapped' : classifyIpv4(embedded);
  }
  if (zeroPrefix(12)) return 'reserved'; // ::/96, the deprecated IPv4-compatible range
  if (b0 === 0x01 && b1 === 0x00 && b2 === 0x00 && b3 === 0x00) return 'reserved'; // 100::/64 discard-only
  if (b0 === 0x00 && b1 === 0x64 && b2 === 0xff && b3 === 0x9b) return 'reserved'; // 64:ff9b::/96 NAT64
  if (b0 === 0x20 && b1 === 0x01 && b2 === 0x00 && b3 === 0x00) return 'reserved'; // 2001::/32 Teredo
  if (b0 === 0x20 && b1 === 0x01 && b2 === 0x0d && b3 === 0xb8) return 'reserved'; // 2001:db8::/32 documentation
  if (b0 === 0x20 && b1 === 0x02) return 'reserved'; // 2002::/16 6to4
  if ((b0 & 0xfe) === 0xfc) return 'unique_local'; // fc00::/7
  if (b0 === 0xfe && (b1 & 0xc0) === 0x80) return 'link_local'; // fe80::/10
  if (b0 === 0xfe && (b1 & 0xc0) === 0xc0) return 'reserved'; // fec0::/10, the deprecated site-local range
  if (b0 === 0xff) return 'multicast';
  return 'public';
}

/**
 * Classify one address. `literal` says the address was written into the URL rather than
 * returned by a resolver, which is the only difference: an IPv4-mapped literal is refused
 * outright, while a resolver that answers in that form is judged on the IPv4 it carries.
 */
export function classifyAddress(address: string, literal = false): AddressClass {
  const family = isIP(address);
  if (family === 4) return classifyIpv4(address);
  if (family === 6) return classifyIpv6(address, literal);
  return 'unknown_family';
}

/** The literal a hostname is, in any spelling, or null when it is a name to resolve. */
export function hostAsLiteral(host: string): ResolvedAddress | null {
  if (isIP(host) === 4) return { address: host, family: 4 };
  if (isIP(host) === 6) return { address: host, family: 6 };
  const loose = parseIpv4Loose(host);
  return loose === null ? null : { address: loose, family: 4 };
}

export type ParsedDestination = { url: URL; host: string; allowlisted: boolean; literal: ResolvedAddress | null };

/**
 * Everything that can be decided without a resolver: the scheme, the credentials, the
 * fragment, the port and the shape of the host. Throws the same `url_not_allowed` the API
 * returns. Registration and dispatch both start here.
 */
export function parseDestination(raw: string, policy: DestinationPolicy): ParsedDestination {
  if (raw.length > URL_MAX) throw destinationRefusal('too_long', '');
  if (/\s/.test(raw)) throw destinationRefusal('not_absolute', '');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw destinationRefusal('not_absolute', '');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw destinationRefusal('scheme_not_allowed', '');
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === '') throw destinationRefusal('host_missing', '');
  if (url.protocol === 'http:' && !policy.allowHttp) throw destinationRefusal('insecure_scheme', host);
  if (url.username !== '' || url.password !== '') throw destinationRefusal('credentials_present', host);
  if (url.hash !== '') throw destinationRefusal('fragment_present', host);
  const port = url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number.parseInt(url.port, 10);
  if (policy.allowedPorts.size > 0 && !policy.allowedPorts.has(port)) throw destinationRefusal('port_not_allowed', host);
  const allowlisted = policy.allowedHosts.has(host);
  const literal = hostAsLiteral(host);
  if (!allowlisted && literal !== null) {
    const verdict = classifyAddress(literal.address, true);
    if (verdict !== 'public') throw destinationRefusal(REFUSAL_OF_CLASS[verdict], host);
  }
  return { url, host, allowlisted, literal };
}

async function resolveHost(host: string, policy: DestinationPolicy): Promise<ResolvedAddress[]> {
  const resolver =
    policy.resolve ??
    (async (hostname: string): Promise<ResolvedAddress[]> => {
      const entries = await dnsLookup(hostname, { all: true, verbatim: true });
      return entries.map((entry) => ({ address: entry.address, family: entry.family === 6 ? 6 : 4 }));
    });
  const timeoutMs = policy.resolveTimeoutMs ?? 5000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      resolver(host),
      new Promise<ResolvedAddress[]>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`resolving ${host} took longer than ${String(timeoutMs)}ms`)), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Resolve and classify. Every answer must be public unicast — one private answer in a
 * round-robin set refuses the whole destination — and the first is the address the
 * dispatcher pins to. `allowUnresolved` is what separates registration (a host whose DNS
 * is not live yet is accepted, and dispatch will judge it again) from dispatch (a
 * destination that will not resolve is a failed attempt).
 */
export async function checkDestination(raw: string, policy: DestinationPolicy, options: { allowUnresolved?: boolean } = {}): Promise<CheckedDestination> {
  const parsed = parseDestination(raw, policy);
  if (parsed.literal !== null) return { url: parsed.url, host: parsed.host, address: parsed.literal };
  let answers: ResolvedAddress[];
  try {
    answers = await resolveHost(parsed.host, policy);
  } catch {
    if (options.allowUnresolved === true) return { url: parsed.url, host: parsed.host, address: null };
    throw destinationRefusal('unresolvable', parsed.host);
  }
  if (answers.length === 0) {
    if (options.allowUnresolved === true) return { url: parsed.url, host: parsed.host, address: null };
    throw destinationRefusal('unresolvable', parsed.host);
  }
  if (!parsed.allowlisted) {
    for (const answer of answers) {
      const verdict = classifyAddress(answer.address, false);
      if (verdict !== 'public') throw destinationRefusal(REFUSAL_OF_CLASS[verdict], parsed.host);
    }
  }
  return { url: parsed.url, host: parsed.host, address: answers[0] ?? null };
}

/** The registration check: a host that does not resolve yet is accepted, every other refusal throws. */
export async function assertRegistrableDestination(raw: string, policy: DestinationPolicy): Promise<URL> {
  return (await checkDestination(raw, policy, { allowUnresolved: true })).url;
}
