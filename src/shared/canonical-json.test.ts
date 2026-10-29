import { describe, expect, it } from 'vitest';
import { canonicalJson } from './canonical-json.js';

describe('canonicalJson', () => {
  it('ignora a ordem das chaves, inclusive dentro de objetos', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(
      canonicalJson({ a: { c: 3, d: 2 }, b: 1 }),
    );
  });

  it('mantém a ordem das listas', () => {
    expect(canonicalJson([2, 1])).not.toBe(canonicalJson([1, 2]));
    expect(canonicalJson({ list: [{ b: 1, a: 2 }] })).toBe('{"list":[{"a":2,"b":1}]}');
  });

  it('trata campo ausente e campo indefinido do mesmo jeito', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }));
  });
});
