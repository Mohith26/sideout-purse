import { devGeoProvider } from './dev/geo';
import { devIdentityProvider, type DevIdentityLists } from './dev/identity';
import { devRiskProvider } from './dev/risk';
import type { Providers } from './types';

export type {
  GeoProvider,
  GeoRequest,
  GeoResolution,
  IdentityCheckRequest,
  IdentityProvider,
  Providers,
  RiskAssessment,
  RiskDecision,
  RiskProvider,
  RiskSignal,
  RiskTransaction,
  VerificationOutcome,
  VerificationResult,
} from './types';
export { devIdentityProvider, DEV_IDENTITY_PROVIDER_NAME, type DevIdentityLists } from './dev/identity';
export { devGeoProvider, resolveDev, DEV_GEO_IP_PREFIXES, DEV_GEO_PROVIDER_NAME } from './dev/geo';
export { devRiskProvider, assessDev, DEV_RISK_PROVIDER_NAME, NEAR_LIMIT_SHARE, NEW_ACCOUNT_MS } from './dev/risk';

/**
 * Which implementation fills each seam. Only `dev` exists today; a vendor integration adds
 * its name here and a branch in `createProviders`, and nothing else in Purse changes.
 */
export const PROVIDER_IMPLEMENTATIONS = ['dev'] as const;
export type ProviderImplementation = (typeof PROVIDER_IMPLEMENTATIONS)[number];

export type ProviderConfig = {
  identity: ProviderImplementation;
  geo: ProviderImplementation;
  risk: ProviderImplementation;
  nodeEnv: 'development' | 'test' | 'production';
  /** Production refuses to start on a dev provider unless this is set explicitly. */
  allowDevProviders: boolean;
  devIdentity?: DevIdentityLists;
};

export class ProviderConfigError extends Error {
  override readonly name = 'ProviderConfigError';
}

/**
 * Build the three providers from configuration. A production process on any `dev`
 * provider is refused unless `ALLOW_DEV_PROVIDERS=true` was set on purpose: a demo may run
 * that way, a licensed deployment must not by accident.
 */
export function createProviders(config: ProviderConfig): Providers {
  const dev = (['identity', 'geo', 'risk'] as const).filter((seam) => config[seam] === 'dev');
  if (config.nodeEnv === 'production' && dev.length > 0 && !config.allowDevProviders) {
    throw new ProviderConfigError(
      `Refusing to start in production with dev providers for ${dev.join(', ')}; set ALLOW_DEV_PROVIDERS=true to run a demo on them deliberately`,
    );
  }
  return {
    identity: devIdentityProvider(config.devIdentity),
    geo: devGeoProvider(),
    risk: devRiskProvider(),
  };
}
