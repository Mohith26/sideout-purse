/**
 * Outbound webhooks (spec 4.9): endpoints with encrypted signing secrets, the outbox
 * (`emitEvent`, called inside the transaction that made the change), the dispatcher that
 * signs and posts with retry and dead-lettering, and the delivery log with replay.
 */
export { WebhookError, WEBHOOK_ERROR_CODES, isWebhookError, type WebhookErrorCode } from './errors';
export {
  assertRegistrableDestination,
  checkDestination,
  classifyAddress,
  destinationPolicy,
  destinationRefusal,
  hostAsLiteral,
  parseDestination,
  parseIpv4Loose,
  URL_MAX,
  type AddressClass,
  type CheckedDestination,
  type DestinationPolicy,
  type DestinationRefusal,
  type ParsedDestination,
  type ResolvedAddress,
} from './destination';
export { nodeTransport, DEFAULT_LIMITS, TransportError, type TransportLimits, type TransportRequest, type TransportResponse, type WebhookTransport } from './transport';
export { BACKOFF_SECONDS, JITTER, WEBHOOK_MAX_ATTEMPTS, retryDelayMs, scheduleTotalSeconds } from './schedule';
export {
  createEndpoint,
  getEndpoint,
  listEndpoints,
  subscribedEndpoints,
  updateEndpoint,
  rotateEndpointSecret,
  endpointSecret,
  mintSecret,
  SECRET_PREFIX,
  type CreateEndpointInput,
  type CreatedEndpoint,
  type UpdateEndpointInput,
  type RotateSecretInput,
} from './endpoints';
export { emitEvent, buildEvent, type EmitEventInput, type EmittedEvent } from './events';
export { WebhookDispatcher, describeFailure, DESTINATION_REFUSED, type DispatcherDeps, type CycleReport, type AttemptOutcome } from './dispatcher';
export {
  getDelivery,
  loadDelivery,
  listDeliveries,
  attemptsOf,
  replayDelivery,
  LIST_LIMIT_MAX,
  type DeliveryWithAttempts,
  type ListDeliveriesInput,
  type ReplayDeliveryInput,
} from './deliveries';
