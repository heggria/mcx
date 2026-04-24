import { describe, expect, test } from 'bun:test';
import { cosine, embeddableText } from '../src/catalog/embed.ts';

describe('cosine similarity', () => {
  test('identical unit vectors → 1', () => {
    const a = new Float32Array([1, 0, 0, 0]);
    expect(cosine(a, a)).toBeCloseTo(1.0, 6);
  });

  test('orthogonal unit vectors → 0', () => {
    const a = new Float32Array([1, 0, 0, 0]);
    const b = new Float32Array([0, 1, 0, 0]);
    expect(cosine(a, b)).toBeCloseTo(0, 6);
  });

  test('opposite unit vectors → -1', () => {
    const a = new Float32Array([1, 0, 0, 0]);
    const b = new Float32Array([-1, 0, 0, 0]);
    expect(cosine(a, b)).toBeCloseTo(-1, 6);
  });

  test('mismatched lengths → 0 (defensive)', () => {
    const a = new Float32Array([1, 0]);
    const b = new Float32Array([1, 0, 0]);
    expect(cosine(a, b)).toBe(0);
  });
});

describe('embeddableText', () => {
  test('joins name + description + args_text', () => {
    const t = embeddableText({
      name: 'create_page',
      description: 'Create a Notion page',
      args_text: 'title parent_id',
    });
    expect(t).toContain('create_page');
    expect(t).toContain('Create a Notion page');
    expect(t).toContain('title parent_id');
  });

  test('skips null/undefined fields', () => {
    expect(embeddableText({ name: 'foo' })).toBe('foo');
    expect(embeddableText({ name: 'foo', description: null })).toBe('foo');
  });

  test('truncates very long text', () => {
    const long = 'x'.repeat(10000);
    const t = embeddableText({ name: 'foo', description: long });
    expect(t.length).toBeLessThanOrEqual(4000);
  });
});
