/*
 * CPF e CNPJ. Desde julho de 2026 a Receita Federal também emite CNPJ
 * alfanumérico: as 12 primeiras posições podem ter letras, e os 2 dígitos
 * verificadores continuam numéricos. A conta dos dígitos é a mesma de sempre,
 * usando como valor de cada caractere o código ASCII menos 48 (de 0 a 9 valem
 * 0 a 9; A vale 17, B vale 18 e assim por diante).
 */

/** Tira pontos, barras, traços e espaços e passa para maiúsculas. */
export function normalizeTaxId(value: string): string {
  return value.replace(/[.\-\/\s]/g, '').toUpperCase();
}

export function isValidCpf(value: string): boolean {
  const cpf = normalizeTaxId(value);
  if (!/^\d{11}$/.test(cpf) || /^(\d)\1{10}$/.test(cpf)) return false;

  const digits = [...cpf].map(Number);
  const base = digits.slice(0, 9);
  const first = checkDigit(base, Number.POSITIVE_INFINITY);
  const second = checkDigit([...base, first], Number.POSITIVE_INFINITY);
  return digits[9] === first && digits[10] === second;
}

export function isValidCnpj(value: string): boolean {
  const cnpj = normalizeTaxId(value);
  if (!/^[0-9A-Z]{12}\d{2}$/.test(cnpj) || /^(.)\1{13}$/.test(cnpj)) return false;

  const values = [...cnpj].map((char) => char.charCodeAt(0) - 48);
  const base = values.slice(0, 12);
  const first = checkDigit(base, 9);
  const second = checkDigit([...base, first], 9);
  return values[12] === first && values[13] === second;
}

/** CPF ou CNPJ válido, com ou sem pontuação. */
export function isValidTaxId(value: string): boolean {
  return isValidCpf(value) || isValidCnpj(value);
}

/**
 * Dígito verificador módulo 11. Os pesos começam em 2 no último caractere e
 * sobem para a esquerda; no CNPJ, voltam a 2 depois do 9.
 */
function checkDigit(values: readonly number[], maxWeight: number): number {
  const sum = [...values]
    .reverse()
    .reduce((total, value, offset) => total + value * (2 + (offset % (maxWeight - 1))), 0);
  const remainder = sum % 11;
  return remainder < 2 ? 0 : 11 - remainder;
}
