import { describe, expect, it } from 'vitest';
import { isRealDate, todayIn, zonedTime } from './dates.js';

describe('todayIn', () => {
  it('usa a data do fuso, não a do UTC', () => {
    // 01:30 em UTC ainda é o dia anterior em São Paulo (UTC-3).
    const now = new Date('2026-11-03T01:30:00Z');
    expect(todayIn('America/Sao_Paulo', now)).toBe('2026-11-02');
    expect(todayIn('UTC', now)).toBe('2026-11-03');
  });
});

describe('zonedTime', () => {
  it('converte a hora local para o instante em UTC', () => {
    expect(zonedTime('2026-11-10T23:59:59', 'America/Sao_Paulo').toISOString()).toBe('2026-11-11T02:59:59.000Z');
    expect(zonedTime('2026-11-10T23:59:59', 'America/Fortaleza').toISOString()).toBe('2026-11-11T02:59:59.000Z');
    expect(zonedTime('2026-11-10T12:00:00', 'UTC').toISOString()).toBe('2026-11-10T12:00:00.000Z');
  });
});

describe('isRealDate', () => {
  it('aceita só datas reais no formato AAAA-MM-DD', () => {
    expect(isRealDate('2026-11-10')).toBe(true);
    expect(isRealDate('2028-02-29')).toBe(true);
    expect(isRealDate('2026-02-29')).toBe(false);
    expect(isRealDate('2026-02-30')).toBe(false);
    expect(isRealDate('10/11/2026')).toBe(false);
    expect(isRealDate(undefined)).toBe(false);
  });
});
