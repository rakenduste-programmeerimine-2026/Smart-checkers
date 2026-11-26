import { describe, expect, it } from 'vitest';
import { chooseMove, evaluate, rankMoves, suggestMove, type AiLevel } from '../../src/ai/engine.js';
import { applyMove, formatMove, initialPosition, legalMoves, setupPosition } from '../../src/game/rules.js';

const LEVELS: AiLevel[] = ['beginner', 'medium', 'strong'];

describe('evaluate', () => {
  it('algseis on tasakaalus', () => {
    expect(evaluate(initialPosition())).toBe(0);
  });

  it('tamm on väärt rohkem kui lihtnupp ja lisanupp annab eelise', () => {
    expect(evaluate(setupPosition({ whiteKings: ['d4'], black: ['e7'] }))).toBeGreaterThan(0);
    expect(evaluate(setupPosition({ white: ['c3'], black: ['f6', 'h6'] }))).toBeLessThan(0);
  });
});

describe('chooseMove', () => {
  it('tagastab igal tasemel seadusliku käigu', () => {
    const pos = initialPosition();
    const legal = legalMoves(pos).map(formatMove);
    for (const level of LEVELS) {
      const choice = chooseMove(pos, { level, random: () => 0.5 });
      expect(choice).not.toBeNull();
      expect(legal).toContain(formatMove(choice!.move));
    }
  });

  it('tagastab null, kui käike pole', () => {
    expect(chooseMove(setupPosition({ white: ['a1'], black: ['b2', 'c3'] }), { level: 'medium' })).toBeNull();
  });

  it('ei anna nuppu niisama ära', () => {
    // c3-d4 ja g3-f4 lasevad mustal e5 lüüa; b4 ja h4 on ohutud.
    const pos = setupPosition({ white: ['c3', 'g3'], black: ['e5'] });
    for (const level of ['medium', 'strong'] as const) {
      expect(['c3-b4', 'g3-h4']).toContain(formatMove(chooseMove(pos, { level })!.move));
    }
  });

  it('valib vaba valiku korral löömise, mis võtab rohkem', () => {
    const pos = setupPosition({ white: ['c3'], black: ['b4', 'd4', 'f6'] });
    expect(formatMove(chooseMove(pos, { level: 'medium' })!.move)).toBe('c3:e5:g7');
  });

  it('leiab tugeval tasemel võidu', () => {
    // Valge tamm ja lihtnupp mustade kahe nupu vastu: valge peab saama selge eelise.
    const pos = setupPosition({ whiteKings: ['a1'], white: ['g3'], black: ['f6', 'b6'] });
    const choice = chooseMove(pos, { level: 'strong' })!;
    expect(choice.score).toBeGreaterThan(0);
  });

  it('on keskmisel ja tugeval tasemel deterministlik (ilma ajapiiranguta)', () => {
    const pos = applyMove(initialPosition(), legalMoves(initialPosition())[0]!);
    for (const level of ['medium', 'strong'] as const) {
      expect(formatMove(chooseMove(pos, { level, timeMs: 60_000 })!.move)).toBe(formatMove(chooseMove(pos, { level, timeMs: 60_000 })!.move));
    }
  });

  it('algaja valib juhuarvu järgi ainult piisavalt heade käikude seast', () => {
    const pos = initialPosition();
    const ranked = rankMoves(pos, 'beginner');
    const best = ranked[0]!.score;
    for (const r of [0, 0.3, 0.6, 0.99]) {
      const choice = chooseMove(pos, { level: 'beginner', random: () => r })!;
      expect(choice.score).toBeGreaterThanOrEqual(best - 120);
    }
  });

  it('tugev tase vastab algseisus mõistliku ajaga', () => {
    const start = Date.now();
    chooseMove(initialPosition(), { level: 'strong' });
    expect(Date.now() - start).toBeLessThan(5000);
  });
});

describe('suggestMove', () => {
  it('pakub kohustusliku löömise korral löömist', () => {
    const pos = setupPosition({ white: ['c3', 'g3'], black: ['d4'] });
    expect(formatMove(suggestMove(pos)!.move)).toBe('c3:e5');
  });
});
