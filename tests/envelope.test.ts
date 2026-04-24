import { describe, expect, test } from 'bun:test';
import { jsonMode } from '../src/envelope.ts';

describe('envelope.jsonMode', () => {
  test('returns true when --json flag is set', () => {
    expect(jsonMode(true)).toBe(true);
  });

  test('returns true when MCX_JSON env is "1"', () => {
    const orig = process.env.MCX_JSON;
    process.env.MCX_JSON = '1';
    try {
      expect(jsonMode(false)).toBe(true);
    } finally {
      if (orig === undefined) delete process.env.MCX_JSON;
      else process.env.MCX_JSON = orig;
    }
  });

  test('returns true when MCX_JSON env is "true"', () => {
    const orig = process.env.MCX_JSON;
    process.env.MCX_JSON = 'true';
    try {
      expect(jsonMode(false)).toBe(true);
    } finally {
      if (orig === undefined) delete process.env.MCX_JSON;
      else process.env.MCX_JSON = orig;
    }
  });

  test('returns true when stdout is not a TTY (test runner)', () => {
    // bun test runs without a TTY, so this should be true.
    const orig = process.env.MCX_JSON;
    delete process.env.MCX_JSON;
    try {
      expect(jsonMode(undefined)).toBe(true);
    } finally {
      if (orig !== undefined) process.env.MCX_JSON = orig;
    }
  });

  test('--json flag overrides everything else', () => {
    const orig = process.env.MCX_JSON;
    process.env.MCX_JSON = '0';
    try {
      expect(jsonMode(true)).toBe(true);
    } finally {
      if (orig === undefined) delete process.env.MCX_JSON;
      else process.env.MCX_JSON = orig;
    }
  });
});
