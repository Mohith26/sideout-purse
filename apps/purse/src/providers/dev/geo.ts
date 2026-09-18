import type { GeoProvider, GeoRequest, GeoResolution } from '../types';

/**
 * The dev geolocation provider: reads a declared region with an IP fallback (spec 4.5).
 * This is where GeoComply would plug in; a real provider fixes the device's position from
 * its own signals and returns a region with a confidence and a fraud verdict.
 *
 * A declared region is taken at face value with moderate confidence. Without one, the IP
 * is looked up in a small table of documentation prefixes (RFC 5737, RFC 6598) so tests and
 * demos can place a user by address; loopback, private and unknown addresses resolve to
 * no region at all, which the evaluator reports as `region_unknown`.
 */
export const DEV_GEO_PROVIDER_NAME = 'dev';

export const DEV_GEO_IP_PREFIXES: ReadonlyArray<readonly [prefix: string, region: string]> = [
  ['203.0.113.', 'US-TX'],
  ['198.51.100.', 'US-CA'],
  ['192.0.2.', 'US-NC'],
  ['100.64.', 'US-NY'],
  ['100.65.', 'GB'],
];

const REGION_CODE = /^[A-Z]{2}(-[A-Z0-9]{1,3})?$/;

export function devGeoProvider(): GeoProvider {
  return {
    name: DEV_GEO_PROVIDER_NAME,
    resolve(request: GeoRequest): Promise<GeoResolution> {
      return Promise.resolve(resolveDev(request));
    },
  };
}

export function resolveDev(request: GeoRequest): GeoResolution {
  const declared = request.declaredRegion?.trim().toUpperCase();
  if (declared !== undefined && declared !== '' && REGION_CODE.test(declared)) {
    return { region: declared, confidence: 0.6, source: 'declared' };
  }
  const ip = request.ip?.trim() ?? '';
  if (ip !== '') {
    const match = DEV_GEO_IP_PREFIXES.find(([prefix]) => ip.startsWith(prefix));
    if (match !== undefined) return { region: match[1], confidence: 0.9, source: 'ip' };
  }
  return { region: null, confidence: 0, source: 'ip' };
}
