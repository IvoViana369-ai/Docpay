/**
 * JSON com as chaves dos objetos em ordem alfabética, para comparar dados pelo
 * conteúdo: { a: 1, b: 2 } e { b: 2, a: 1 } dão o mesmo texto. A ordem das
 * listas é mantida. Serve só para dados simples (texto, número, booleano,
 * listas e objetos).
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(object)
        .sort()
        .map((key) => [key, sortKeys(object[key])]),
    );
  }
  return value;
}
