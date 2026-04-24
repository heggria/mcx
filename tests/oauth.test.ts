import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { base64url, generatePkce } from '../src/auth/oauth.ts';

describe('PKCE generation', () => {
  test('verifier is URL-safe base64', () => {
    const { verifier } = generatePkce();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier.length).toBeLessThanOrEqual(128);
    // Only [A-Za-z0-9-_]
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  test('challenge is SHA256(verifier) base64url', () => {
    const { verifier, challenge, method } = generatePkce();
    expect(method).toBe('S256');
    const expected = base64url(createHash('sha256').update(verifier).digest());
    expect(challenge).toBe(expected);
  });

  test('each call yields fresh randomness', () => {
    const a = generatePkce();
    const b = generatePkce();
    expect(a.verifier).not.toBe(b.verifier);
    expect(a.challenge).not.toBe(b.challenge);
  });
});

describe('base64url encoding', () => {
  test('strips =, replaces +/ with -_', () => {
    const buf = Buffer.from([0xff, 0xff, 0xff]);
    const out = base64url(buf);
    expect(out).not.toContain('=');
    expect(out).not.toContain('+');
    expect(out).not.toContain('/');
  });

  test('round-trip with Buffer.from base64url', () => {
    const orig = Buffer.from('hello world');
    const enc = base64url(orig);
    // Reverse: pad and unswap
    const padded = enc.replace(/-/g, '+').replace(/_/g, '/').padEnd(
      Math.ceil(enc.length / 4) * 4,
      '=',
    );
    const dec = Buffer.from(padded, 'base64');
    expect(dec.toString('utf8')).toBe('hello world');
  });
});
