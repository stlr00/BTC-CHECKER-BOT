import { describe, expect, it } from 'vitest';
import { parseTarget } from './parse.js';

describe('parseTarget', () => {
  it.each([
    ['bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh', 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh'],
    ['BC1QXY2KGDYGJRSQTZQ2N0YRF2493P83KKFJHX0WLH', 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh'],
    ['bc1p5d7rjq7g6rdk2yhzks9smlaqtedr4dekq08ge8ztwac72sfr9rusxg3297', 'bc1p5d7rjq7g6rdk2yhzks9smlaqtedr4dekq08ge8ztwac72sfr9rusxg3297'],
    ['1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa', '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa'],
    ['3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy', '3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy'],
  ])('распознаёт адрес %s', (input, expected) => {
    expect(parseTarget(input)).toEqual({ kind: 'address', value: expected });
  });

  it('распознаёт txid и приводит к нижнему регистру', () => {
    const txid = '4A5E1E4BAAB89F3A32518A88C31BC87F618F76673E2CC77AB2127B7AFDEDA33B';
    expect(parseTarget(` ${txid} `)).toEqual({ kind: 'txid', value: txid.toLowerCase() });
  });

  it.each(['hello', 'bc1qXY2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh', '0OIl' + '1'.repeat(30), 'abc123'])(
    'отклоняет %s',
    (input) => expect(parseTarget(input)).toBeNull(),
  );
});
