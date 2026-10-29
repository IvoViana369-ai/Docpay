import { isCents, type Cents } from './cents.js';

/**
 * Divide um valor em partes proporcionais aos pesos, sem perder centavo.
 *
 * Cada parte recebe a fração inteira que lhe cabe (arredondada para baixo).
 * Os centavos que sobram vão, um a um, para as partes com maior resto; no
 * empate, para a que vem primeiro na lista (método do maior resto). A soma
 * das partes é sempre igual ao valor, e peso zero sempre recebe zero.
 *
 * Exemplo: allocateProportionally(100, [1, 1, 1]) → [34, 33, 33].
 */
export function allocateProportionally(amount: Cents, weights: readonly number[]): Cents[] {
  if (!isCents(amount)) {
    throw new RangeError(
      `Valor inválido para rateio (${String(amount)}). Use centavos inteiros e não negativos.`,
    );
  }
  if (weights.length === 0) {
    throw new RangeError('Rateio sem nenhuma parte.');
  }
  for (const weight of weights) {
    if (!Number.isSafeInteger(weight) || weight < 0) {
      throw new RangeError(
        `Peso inválido para rateio (${String(weight)}). Use inteiros não negativos.`,
      );
    }
  }

  const total = weights.reduce((sum, weight) => sum + BigInt(weight), 0n);
  if (total === 0n) {
    if (amount === 0) return weights.map(() => 0);
    throw new RangeError('Não é possível ratear: todos os pesos são zero.');
  }

  const value = BigInt(amount);
  const parts = weights.map((weight) => (value * BigInt(weight)) / total);
  const leftover = value - parts.reduce((sum, part) => sum + part, 0n);

  const getsExtraCent = new Set(
    weights
      .map((weight, index) => ({ index, remainder: (value * BigInt(weight)) % total }))
      .sort((a, b) =>
        a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1,
      )
      .slice(0, Number(leftover))
      .map(({ index }) => index),
  );

  return parts.map((part, index) => Number(part + (getsExtraCent.has(index) ? 1n : 0n)));
}
