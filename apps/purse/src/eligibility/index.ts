/**
 * The eligibility and compliance engine (spec 4.5, decision D9). `evaluate` is pure and
 * lives with the ruleset schema; everything else here reads the database to feed it and
 * to persist what it decided.
 */
export { evaluate, isActive, minimumAge, regionPermitted, ageOn, REASON_PRIORITY, type EvaluateInput, type RestrictionInput } from './evaluate';
export { rulesetSchema, parseRuleset, regionCodeSchema, RulesetError, SPEC_EXAMPLE_RULESET, RULESET_VERSION_SHAPE, type Ruleset, type RulesetInput } from './ruleset';
export {
  publishRuleset,
  activateRuleset,
  activeRuleset,
  requireActiveRuleset,
  rulesetByVersion,
  rulesetForContest,
  findRulesetForContest,
  listRulesets,
  type PublishRulesetInput,
  type PublishedRuleset,
  type ActivateRulesetInput,
} from './rulesets';
export { entryVelocity, VELOCITY_WINDOWS, type Velocity } from './velocity';
export { decideEntry, recordDecision, openFlagsOf, flagRiskReview, type DecideEntryInput, type EntryDecision, type RecordDecisionInput } from './decide';
export { collusionPairs, flagCollusion, type CollusionPair, type CollusionScan } from './collusion';
