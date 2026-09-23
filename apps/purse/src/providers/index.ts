import type { ProviderImplementation } from '../env';
import { devFundingProvider } from './dev/funding';
import { devGeoProvider } from './dev/geo';
import { devIdentityProvider, type DevIdentityLists } from './dev/identity';
import { devRiskProvider } from './dev/risk';
import type { Providers } from './types';

export type {
  ChargeRequest,
  FundingCapabilities,
  FundingInstrument,
  FundingOutcome,
  FundingProvider,
  FundingResult,
  GeoProvider,
  GeoRequest,
  GeoResolution,
  IdentityCheckRequest,
  IdentityProvider,
  PayoutRequest,
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
export {
  devFundingProvider,
  chargeDev,
  payoutDev,
  railFee,
  BANK_FEE_FIXED_CENTS,
  CARD_FEE_BPS,
  CARD_FEE_FIXED_CENTS,
  DEV_FUNDING_CAPABILITIES,
  DEV_FUNDING_PROVIDER_NAME,
  SCRIPTED_DECLINES,
} from './dev/funding';

/**
 * Which implementation fills each seam: `PROVIDER_IMPLEMENTATIONS` in `../env`. Only `dev`
 * exists today; a vendor integration adds its name there and a branch in
 * `createProviders`, and nothing else in Purse changes.
 */
export { PROVIDER_IMPLEMENTATIONS, type ProviderImplementation } from '../env';

export type ProviderConfig = {
  identity: ProviderImplementation;
  geo: ProviderImplementation;
  risk: ProviderImplementation;
  funding: ProviderImplementation;
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
  const dev = (['identity', 'geo', 'risk', 'funding'] as const).filter((seam) => config[seam] === 'dev');
  if (config.nodeEnv === 'production' && dev.length > 0 && !config.allowDevProviders) {
    throw new ProviderConfigError(
      `Refusing to start in production with dev providers for ${dev.join(', ')}; set ALLOW_DEV_PROVIDERS=true to run a demo on them deliberately`,
    );
  }
  return {
    identity: devIdentityProvider(config.devIdentity),
    geo: devGeoProvider(),
    risk: devRiskProvider(),
    funding: devFundingProvider(),
  };
}
