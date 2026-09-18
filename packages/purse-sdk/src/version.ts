/**
 * The SDK version, reported by both `/health` endpoints so an operator can see at a glance
 * which SDK a deployment speaks. Kept in lockstep with `package.json` by a unit test
 * rather than a JSON import, so it bundles into a browser build without import attributes.
 */
export const SDK_VERSION = '0.0.1';
