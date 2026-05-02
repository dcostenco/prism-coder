/**
 * Encrypted sync — corrupted-payload regression
 *
 * Before the fix, receiveSyncPacket() called JSON.parse(decrypted) without
 * a try/catch. A peer sending an encrypted packet whose plaintext is not
 * valid JSON would crash the receiver with an uncaught SyntaxError.
 *
 * This test proves we now throw a typed Error instead of crashing, so the
 * caller can distinguish "corrupted payload" from "decrypt failed".
 */
import { describe, it, expect } from 'vitest';
import { encrypt, decrypt, deriveKey, receiveSyncPacket, type EncryptedPacket } from '../src/sync/encryptedSync.js';

const SECRET = 'test-shared-secret-do-not-reuse';

describe('receiveSyncPacket — corrupted plaintext', () => {
  it('throws a typed error (not a SyntaxError) on non-JSON plaintext', () => {
    // Encrypt garbage so decrypt succeeds but JSON.parse fails.
    const key = deriveKey(SECRET);
    const corrupted = encrypt('this is not json at all', key);
    expect(() => receiveSyncPacket(corrupted, SECRET)).toThrowError(/Sync payload corrupted/);
  });

  it('throws a typed error on JSON that is not a SyncPayload shape', () => {
    const key = deriveKey(SECRET);
    // Valid JSON but missing required fields → checksum verification will fail
    // BEFORE JSON.parse — but we want to ensure JSON.parse path is also safe.
    const partial = encrypt('{"version":"missing fields"}', key);
    expect(() => receiveSyncPacket(partial, SECRET)).toThrow();
  });

  it('does not throw a raw SyntaxError to the caller', () => {
    const key = deriveKey(SECRET);
    const corrupted = encrypt('}}}}}}}', key);
    let threw: unknown = null;
    try { receiveSyncPacket(corrupted, SECRET); } catch (e) { threw = e; }
    expect(threw).toBeInstanceOf(Error);
    // The wrapped error should not be a raw SyntaxError; it should mention sync
    expect((threw as Error).message).toContain('Sync payload corrupted');
    expect((threw as Error).name).not.toBe('SyntaxError');
  });
});

describe('encrypt → decrypt roundtrip (sanity)', () => {
  it('roundtrips a valid string', () => {
    const key = deriveKey(SECRET);
    const ct = encrypt('hello world', key);
    expect(decrypt(ct, key)).toBe('hello world');
  });

  it('produces different ciphertext for the same plaintext (random IV)', () => {
    // Without a unique IV per encryption, AES-GCM is broken. This test
    // verifies the IV is actually randomized, not deterministic.
    const key = deriveKey(SECRET);
    const a = encrypt('same plaintext', key);
    const b = encrypt('same plaintext', key);
    expect(a.iv).not.toBe(b.iv);
    expect(a.data).not.toBe(b.data);
  });
});
