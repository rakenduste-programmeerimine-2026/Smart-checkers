import { describe, expect, it } from 'vitest';
import { THRESHOLDS, classify, reviewGame } from '../../src/analysis/review.js';
import { rankMoves } from '../../src/ai/engine.js';
import { applyMove, formatMove, initialPosition, setupPosition } from '../../src/game/rules.js';
import type { Move, Position } from '../../src/game/types.js';

const noPause = async () => {};
const opts = { level: 'beginner' as const, timePerMoveMs: 10_000, yieldEvery: noPause };

/** Mängib käigud: igal sammul valib funktsioon pingereast käigu. */
const playGame = (picks: ((ranked: Move[]) => Move)[], start: Position = initialPosition()) => {
  const positions = [start];
  const moves: Move[] = [];
  for (const pick of picks) {
    const pos = positions[positions.length - 1]!;
    const move = pick(rankMoves(pos, 'beginner', { timeMs: 10_000 }).map((c) => c.move));
    moves.push(move);
    positions.push(applyMove(pos, move));
  }
  return { positions, moves };
};
const best = (r: Move[]) => r[0]!;
const worst = (r: Move[]) => r[r.length - 1]!;

describe('classify', () => {
  it('jagab kaotuse järgi klassidesse', () => {
    expect(classify(0, false)).toBe('best');
    expect(classify(THRESHOLDS.good - 1, false)).toBe('good');
    expect(classify(THRESHOLDS.good, false)).toBe('inaccuracy');
    expect(classify(THRESHOLDS.inaccuracy, false)).toBe('mistake');
    expect(classify(THRESHOLDS.mistake, false)).toBe('blunder');
    expect(classify(999, true)).toBe('forced');
  });
});

describe('reviewGame', () => {
  it('parimad käigud on "best" ja täpsus 100', async () => {
    const { positions, moves } = playGame([best, best, best, best]);
    const review = await reviewGame(positions, moves, opts);
    expect(review.moves).toHaveLength(4);
    expect(review.moves.map((m) => m.color)).toEqual(['white', 'black', 'white', 'black']);
    expect(review.moves.every((m) => m.classification === 'best' && m.loss === 0 && m.best === m.move)).toBe(true);
    expect(review.summary.white).toEqual({ accuracy: 100, inaccuracies: 0, mistakes: 0, blunders: 0 });
    expect(review.keyMoments).toEqual([]);
  });

  it('leiab halva käigu ja pakub paremat', async () => {
    // Valge hoiab tagumise rea ja annab nupu ära: lihtsaim viis on valida igal käigul halvim.
    const { positions, moves } = playGame([worst, best, worst, best, worst, best]);
    const review = await reviewGame(positions, moves, opts);
    const white = review.moves.filter((m) => m.color === 'white');
    expect(white.some((m) => m.loss > 0 && m.best !== m.move)).toBe(true);
    expect(review.summary.white.accuracy).toBeLessThan(review.summary.black.accuracy);
    for (const ply of review.keyMoments) {
      expect(['mistake', 'blunder']).toContain(review.moves[ply]!.classification);
    }
    const losses = review.keyMoments.map((p) => review.moves[p]!.loss);
    expect(losses).toEqual([...losses].sort((a, b) => b - a));
  });

  it('ainus seaduslik käik on "forced" ega mõjuta täpsust', async () => {
    // Valge peab lööma: ainus käik.
    const start = setupPosition({ white: ['c3'], black: ['d4', 'h8'] });
    const { positions, moves } = playGame([best], start);
    const review = await reviewGame(positions, moves, opts);
    expect(review.moves[0]).toMatchObject({ classification: 'forced', move: formatMove(moves[0]!) });
    expect(review.summary.white.accuracy).toBe(100);
  });

  it('tühi mäng ja vaikimisi valikud', async () => {
    const review = await reviewGame([initialPosition()], []);
    expect(review).toEqual({
      moves: [],
      summary: {
        white: { accuracy: 100, inaccuracies: 0, mistakes: 0, blunders: 0 },
        black: { accuracy: 100, inaccuracies: 0, mistakes: 0, blunders: 0 },
      },
      keyMoments: [],
    });
  });
});
