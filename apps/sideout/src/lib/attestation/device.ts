import { exportPublicJwk, generateAttestationKeyPair, jwkThumbprint, signAttestation, type EcPublicJwk } from '@purse/types';

import { attestationPayload, type SubmittedAttestation } from '../../domain/attestation';
import type { SetScore } from '../../domain/scoreline';

/**
 * This phone's signing key (spec section 12, item 1; `docs/attestation.md`). A
 * non-extractable ECDSA P-256 key pair generated with Web Crypto the first time it is
 * needed and kept in IndexedDB beside the score outbox, so the private key never exists
 * anywhere but inside the browser's key store: nothing here can read it, export it, log
 * it or send it. What leaves the phone is the public half (registered for a team at
 * check-in) and signatures over the canonical scoreline.
 *
 * A browser that refuses IndexedDB (a private window, say) gets a key for the session:
 * check-in works, and the next session is a new phone as far as the team is concerned.
 */
export type DeviceKey = { keyId: string; publicKey: EcPublicJwk; privateKey: CryptoKey };

export const DEVICE_DB = 'sideout-device';
const KEY_STORE = 'keys';
const CURRENT = 'current';
const DEVICE_DB_VERSION = 1;

type StoredKey = { id: typeof CURRENT; keyId: string; publicKey: EcPublicJwk; privateKey: CryptoKey };

function isStoredKey(value: unknown): value is StoredKey {
  if (typeof value !== 'object' || value === null) return false;
  const row = value as Partial<StoredKey>;
  return row.id === CURRENT && typeof row.keyId === 'string' && typeof row.publicKey === 'object' && row.publicKey !== null && typeof row.privateKey === 'object' && row.privateKey !== null;
}

export type DeviceKeyStore = {
  read(): Promise<StoredKey | null>;
  write(key: StoredKey): Promise<void>;
};

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

/** `CryptoKey` objects are structured-cloneable, so IndexedDB stores the pair itself; the private half stays non-extractable. */
export class IndexedDbKeyStore implements DeviceKeyStore {
  private db: Promise<IDBDatabase> | null = null;

  constructor(private readonly factory: IDBFactory) {}

  private open(): Promise<IDBDatabase> {
    this.db ??= new Promise((resolve, reject) => {
      const req = this.factory.open(DEVICE_DB, DEVICE_DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(KEY_STORE)) db.createObjectStore(KEY_STORE, { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('Could not open the device key database'));
    });
    return this.db;
  }

  async read(): Promise<StoredKey | null> {
    const db = await this.open();
    const tx = db.transaction(KEY_STORE, 'readonly');
    const row: unknown = await request(tx.objectStore(KEY_STORE).get(CURRENT));
    await done(tx);
    return isStoredKey(row) ? row : null;
  }

  async write(key: StoredKey): Promise<void> {
    const db = await this.open();
    const tx = db.transaction(KEY_STORE, 'readwrite');
    tx.objectStore(KEY_STORE).put(key);
    await done(tx);
  }
}

export class MemoryKeyStore implements DeviceKeyStore {
  private key: StoredKey | null = null;
  async read(): Promise<StoredKey | null> {
    await Promise.resolve();
    return this.key;
  }
  async write(key: StoredKey): Promise<void> {
    await Promise.resolve();
    this.key = key;
  }
}

let store: DeviceKeyStore | null = null;
let loading: Promise<DeviceKey | null> | null = null;

function keyStore(): DeviceKeyStore {
  store ??= typeof indexedDB === 'undefined' ? new MemoryKeyStore() : new IndexedDbKeyStore(indexedDB);
  return store;
}

/** Test hook: swap the store and forget any cached key. */
export function useDeviceKeyStoreForTests(next: DeviceKeyStore | null): void {
  store = next;
  loading = null;
}

/** Whether this browser can sign at all: Web Crypto's `subtle` needs a secure context (https, or localhost). */
export function canSign(): boolean {
  return typeof crypto !== 'undefined' && crypto.subtle !== undefined;
}

/** This phone's key if it has one; never generates. */
export async function currentDeviceKey(): Promise<DeviceKey | null> {
  if (!canSign()) return null;
  loading ??= keyStore()
    .read()
    .then((row) => (row === null ? null : { keyId: row.keyId, publicKey: row.publicKey, privateKey: row.privateKey }))
    .catch(() => null);
  return loading;
}

/** This phone's key, generated and stored on first use. */
export async function ensureDeviceKey(): Promise<DeviceKey> {
  const existing = await currentDeviceKey();
  if (existing !== null) return existing;
  if (!canSign()) throw new Error('This browser cannot sign: Web Crypto needs a secure (https) page.');
  const pair = await generateAttestationKeyPair();
  const publicKey = await exportPublicJwk(pair.publicKey);
  const keyId = await jwkThumbprint(publicKey);
  const fresh: DeviceKey = { keyId, publicKey, privateKey: pair.privateKey };
  try {
    await keyStore().write({ id: CURRENT, keyId, publicKey, privateKey: pair.privateKey });
  } catch {
    // The key store refused (a private window that blocks IndexedDB): keep the pair for the session.
    store = new MemoryKeyStore();
    await store.write({ id: CURRENT, keyId, publicKey, privateKey: pair.privateKey });
  }
  loading = Promise.resolve(fresh);
  return fresh;
}

export type SigningBinding = { tournamentId: string; matchId: string; teamId: string };

/** Sign a match-oriented scoreline for this match and team, now. What the server verifies against the checked-in key. */
export async function signScoreline(key: DeviceKey, binding: SigningBinding, sets: readonly SetScore[], now: Date = new Date()): Promise<SubmittedAttestation> {
  const timestamp = now.toISOString();
  const payload = attestationPayload({ keyId: key.keyId, timestamp, tournamentId: binding.tournamentId, matchId: binding.matchId, teamId: binding.teamId, sets });
  return { keyId: key.keyId, algorithm: 'ES256', signature: await signAttestation(key.privateKey, payload), timestamp };
}
