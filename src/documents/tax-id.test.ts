import { describe, expect, it } from 'vitest';
import { isValidCnpj, isValidCpf, isValidTaxId, normalizeTaxId } from './tax-id.js';

describe('normalizeTaxId', () => {
  it('tira a pontuação e passa para maiúsculas', () => {
    expect(normalizeTaxId('529.982.247-25')).toBe('52998224725');
    expect(normalizeTaxId(' 12.abc.345/01de-35 ')).toBe('12ABC34501DE35');
  });
});

describe('isValidCpf', () => {
  it('aceita CPF com dígitos certos, com ou sem pontuação', () => {
    expect(isValidCpf('529.982.247-25')).toBe(true);
    expect(isValidCpf('52998224725')).toBe(true);
  });

  it('recusa dígito errado, tamanho errado e números repetidos', () => {
    expect(isValidCpf('529.982.247-26')).toBe(false);
    expect(isValidCpf('5299822472')).toBe(false);
    expect(isValidCpf('111.111.111-11')).toBe(false);
    expect(isValidCpf('11.222.333/0001-81')).toBe(false);
  });
});

describe('isValidCnpj', () => {
  it('aceita CNPJ numérico', () => {
    expect(isValidCnpj('11.222.333/0001-81')).toBe(true);
    expect(isValidCnpj('11222333000181')).toBe(true);
  });

  it('aceita CNPJ alfanumérico, inclusive em minúsculas', () => {
    expect(isValidCnpj('12.ABC.345/01DE-35')).toBe(true);
    expect(isValidCnpj('12.abc.345/01de-35')).toBe(true);
  });

  it('recusa dígito errado, letra nos dígitos verificadores e caracteres repetidos', () => {
    expect(isValidCnpj('11.222.333/0001-82')).toBe(false);
    expect(isValidCnpj('12.ABC.345/01DE-36')).toBe(false);
    expect(isValidCnpj('12ABC34501DE3A')).toBe(false);
    expect(isValidCnpj('00000000000000')).toBe(false);
    expect(isValidCnpj('529.982.247-25')).toBe(false);
  });
});

describe('isValidTaxId', () => {
  it('aceita CPF ou CNPJ', () => {
    expect(isValidTaxId('529.982.247-25')).toBe(true);
    expect(isValidTaxId('12.ABC.345/01DE-35')).toBe(true);
    expect(isValidTaxId('123')).toBe(false);
    expect(isValidTaxId('')).toBe(false);
  });
});
