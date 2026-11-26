import { describe, expect, it } from 'vitest';
import { DEFAULT_TIME_MS, chooseMove, rankMoves, searchMoves } from '../../src/ai/engine.js';
import { DRAW_LONE_KING_PLIES, initialPosition, legalMoves, setupPosition } from '../../src/game/rules.js';

/** Kell, mis liigub iga küsimisega edasi: nii saab aja otsasaamist järele teha. */
const tickingClock = (stepMs: number) => {
  let t = 0;
  return () => (t += stepMs);
};

describe('mootori ajapiirang', () => {
  it('lõpetab ilma ajapiiranguta kogu sügavuse', () => {
    const { depth, choices } = searchMoves(initialPosition(), 'medium', { timeMs: 60_000 });
    expect(depth).toBe(4);
    expect(choices).toHaveLength(7);
  });

  it('kui aeg saab otsa, kasutab viimast lõpetatud sügavust, aga annab alati käigu', () => {
    const { depth, choices } = searchMoves(initialPosition(), 'strong', { timeMs: 0, now: tickingClock(1) });
    // Kella vaadatakse iga 512 sõlme järel, nii et madalad sügavused jõuavad lõpuni.
    expect(depth).toBeGreaterThanOrEqual(1);
    expect(depth).toBeLessThan(7);
    expect(choices).toHaveLength(7);
    const choice = chooseMove(initialPosition(), { level: 'strong', timeMs: 0, now: tickingClock(1) });
    expect(legalMoves(initialPosition()).map((m) => m.from)).toContain(choice!.move.from);
  });

  it('tugev tase peab tegelikus ajas piiri', () => {
    const position = setupPosition({
      whiteKings: ['a1', 'c1'],
      white: ['c3', 'e3', 'g3', 'b2'],
      blackKings: ['h8', 'f8'],
      black: ['b6', 'd6', 'f6', 'h6'],
    });
    const started = Date.now();
    rankMoves(position, 'strong', { timeMs: 200 });
    // Kella vaadatakse iga 512 sõlme tagant, nii et väike ülekulu on lubatud.
    expect(Date.now() - started).toBeLessThan(200 + 400);
    expect(DEFAULT_TIME_MS).toBeLessThanOrEqual(1500);
  });

  it('peab 3 tammi ühe vastu seisu viigiks, kui 15 käiku on täis', () => {
    const base = setupPosition({ whiteKings: ['a1', 'c1', 'e1'], blackKings: ['h8'], turn: 'black' });
    const drawn = { ...base, loneKingPlies: DRAW_LONE_KING_PLIES - 1 };
    // Musta iga käik viib viigini (loendur täis), seega hinnang on 0.
    const ranked = rankMoves(drawn, 'medium', { timeMs: 60_000 });
    expect(ranked.every((c) => c.score === 0)).toBe(true);
  });
});
