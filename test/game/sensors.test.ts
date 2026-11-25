import { describe, expect, it } from 'vitest';
import { applyMove, findMove, initialPosition, setupPosition } from '../../src/game/rules.js';
import { detectMove, diffAgainst, occupancyMask, squaresInMask } from '../../src/game/sensors.js';
import { parseSquare, squareName } from '../../src/game/squares.js';
import { formatMove } from '../../src/game/rules.js';

const bit = (name: string): number => (1 << parseSquare(name)!) >>> 0;

describe('occupancyMask', () => {
  it('algseisus on 12 alumist ja 12 ülemist bitti', () => {
    expect(occupancyMask(initialPosition().board)).toBe(0xfff00fff);
  });

  it('squaresInMask on pöördtehe', () => {
    expect(squaresInMask(bit('a1') | bit('h8')).map(squareName)).toEqual(['a1', 'h8']);
  });
});

describe('detectMove', () => {
  it('tunneb ära muutumatu laua', () => {
    const pos = initialPosition();
    expect(detectMove(pos, occupancyMask(pos.board))).toEqual({ kind: 'unchanged' });
  });

  it('tunneb ära lihtkäigu', () => {
    const pos = initialPosition();
    const mask = (occupancyMask(pos.board) & ~bit('c3')) | bit('d4');
    const d = detectMove(pos, mask);
    expect(d.kind).toBe('move');
    if (d.kind === 'move') expect(formatMove(d.move)).toBe('c3-d4');
  });

  it('tunneb ära mitmekordse löömise', () => {
    const pos = setupPosition({ white: ['c3'], black: ['d4', 'f6', 'a7'] });
    const after = applyMove(pos, findMove(pos, 'c3:g7')!);
    const d = detectMove(pos, occupancyMask(after.board));
    expect(d.kind).toBe('move');
    if (d.kind === 'move') expect(formatMove(d.move)).toBe('c3:e5:g7');
  });

  it('annab pooleli käigu või vea korral puuduvad ja liigsed ruudud', () => {
    const pos = initialPosition();
    const lifted = occupancyMask(pos.board) & ~bit('c3');
    expect(detectMove(pos, lifted)).toEqual({ kind: 'mismatch', missing: [parseSquare('c3')], extra: [] });
    const illegal = (lifted | bit('c5')) >>> 0;
    const d = detectMove(pos, illegal);
    expect(d.kind).toBe('mismatch');
    if (d.kind === 'mismatch') expect(d.extra.map(squareName)).toEqual(['c5']);
  });
});

describe('diffAgainst', () => {
  it('näitab, mida laual on vaja muuta, et jõuda oodatud seisuni', () => {
    const pos = initialPosition();
    const expected = applyMove(pos, findMove(pos, 'c3-d4')!).board;
    expect(diffAgainst(expected, occupancyMask(pos.board))).toEqual({
      missing: [parseSquare('d4')],
      extra: [parseSquare('c3')],
    });
  });
});
