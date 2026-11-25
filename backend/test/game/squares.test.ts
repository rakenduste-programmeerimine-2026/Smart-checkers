import { describe, expect, it } from 'vitest';
import { fileOf, parseSquare, rankOf, squareName, step, toSquare } from '../../src/game/squares.js';

describe('squares', () => {
  it('nummerdab ruudud laua reed-lülitite järjekorras', () => {
    expect(squareName(0)).toBe('a1');
    expect(squareName(1)).toBe('c1');
    expect(squareName(4)).toBe('b2');
    expect(squareName(13)).toBe('d4');
    expect(squareName(16)).toBe('a5');
    expect(squareName(31)).toBe('h8');
  });

  it('teisendab nime ja indeksi edasi-tagasi kõigil 32 ruudul', () => {
    for (let sq = 0; sq < 32; sq++) {
      expect(parseSquare(squareName(sq))).toBe(sq);
      expect(toSquare(fileOf(sq), rankOf(sq))).toBe(sq);
    }
  });

  it('tagastab heledale või vigasele ruudule null', () => {
    expect(parseSquare('a2')).toBeNull();
    expect(parseSquare('i1')).toBeNull();
    expect(parseSquare('')).toBeNull();
    expect(toSquare(8, 0)).toBeNull();
  });

  it('astub diagonaalis ja peatub laua serval', () => {
    expect(step(parseSquare('c3')!, 1, 1)).toBe(parseSquare('d4'));
    expect(step(parseSquare('a1')!, -1, 1)).toBeNull();
    expect(step(parseSquare('h8')!, 1, 1)).toBeNull();
  });

  it('viskab vigase indeksi peale vea', () => {
    expect(() => squareName(32)).toThrow(RangeError);
  });
});
