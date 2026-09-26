import { describe, expect, it } from 'vitest';
import { btc, duration, money, plural } from './format.js';

describe('format', () => {
  it('форматирует сумму в BTC со знаком', () => {
    expect(btc(123_456_789)).toBe('1.23456789 BTC');
    expect(btc(10_000, { sign: true })).toBe('+0.00010000 BTC');
    expect(btc(-5_000, { sign: true })).toBe('−0.00005000 BTC');
  });

  it('показывает сумму в BTC, USD и RUB', () => {
    const prices = { usd: 80_000, rub: 6_750_000 };
    expect(money(100_000, prices, { sign: true })).toBe('+0.00100000 BTC · $80.00 · 6\u00a0750 ₽');
    expect(money(-10_000, prices, { sign: true })).toBe('−0.00010000 BTC · $8.00 · 675 ₽');
    expect(money(1_000, prices)).toBe('0.00001000 BTC · $0.80 · 67,50 ₽');
    expect(money(1_000, { usd: 80_000, rub: null })).toBe('0.00001000 BTC · $0.80');
  });

  it('ставит основную валюту первой и знак только у неё', () => {
    const prices = { usd: 80_000, rub: 6_750_000 };
    expect(money(-10_000, prices, { sign: true, currency: 'rub' })).toBe('−675 ₽ · 0.00010000 BTC · $8.00');
    expect(money(10_000, prices, { sign: true, currency: 'usd' })).toBe('+$8.00 · 0.00010000 BTC · 675 ₽');
  });

  it('скрывает остальные валюты', () => {
    const prices = { usd: 80_000, rub: 6_750_000 };
    expect(money(10_000, prices, { currency: 'usd', showOthers: false })).toBe('$8.00');
    expect(money(10_000, prices, { currency: 'btc', showOthers: false })).toBe('0.00010000 BTC');
  });

  it('показывает BTC, если курс основной валюты недоступен', () => {
    expect(money(10_000, { usd: 80_000, rub: null }, { currency: 'rub', showOthers: false })).toBe('0.00010000 BTC');
    expect(money(10_000, { usd: null, rub: null }, { currency: 'usd' })).toBe('0.00010000 BTC');
  });

  it('форматирует длительность', () => {
    expect(duration(45_000)).toBe('45 сек');
    expect(duration(12 * 60_000 + 34_000)).toBe('12 мин 34 сек');
    expect(duration(2 * 3_600_000 + 5 * 60_000)).toBe('2 ч 5 мин');
    expect(duration(-1000)).toBe('0 сек');
  });

  it('склоняет существительные', () => {
    const f = (n: number) => plural(n, 'подтверждение', 'подтверждения', 'подтверждений');
    expect([1, 2, 5, 11, 21, 22, 112].map(f)).toEqual([
      'подтверждение',
      'подтверждения',
      'подтверждений',
      'подтверждений',
      'подтверждение',
      'подтверждения',
      'подтверждений',
    ]);
  });
});
