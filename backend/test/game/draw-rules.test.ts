import { describe, expect, it } from 'vitest';
import {
  DRAW_LONE_KING_PLIES,
  applyMove,
  findMove,
  gameResult,
  initialPosition,
  isLoneKingEnding,
  positionKey,
  repetitionCount,
  setupPosition,
} from '../../src/game/rules.js';
import type { Position } from '../../src/game/types.js';

const play = (pos: Position, text: string) => {
  const move = findMove(pos, text);
  if (!move) throw new Error(`Vigane käik ${text}`);
  return applyMove(pos, move);
};

/** Mängib käigud läbi ja tagastab kõik seisud (esimene = algseis). */
const history = (start: Position, moves: string[]) => {
  const positions = [start];
  for (const m of moves) positions.push(play(positions[positions.length - 1]!, m));
  return positions;
};

describe('kolmekordne kordus', () => {
  const start = setupPosition({ whiteKings: ['a3'], white: ['c1'], blackKings: ['h6'], black: ['f8'] });
  const shuffle = ['a3-b4', 'h6-g5', 'b4-a3', 'g5-h6'];

  it('positionKey eristab käigul olevat poolt ja tammi', () => {
    const black = { ...start, turn: 'black' as const };
    expect(positionKey(start)).not.toBe(positionKey(black));
    expect(positionKey(initialPosition())).toBe(positionKey(initialPosition()));
    const manInsteadOfKing = setupPosition({ white: ['a3', 'c1'], blackKings: ['h6'], black: ['f8'] });
    expect(positionKey(start)).not.toBe(positionKey(manInsteadOfKing));
  });

  it('sama seis kolmandat korda on viik', () => {
    const once = history(start, shuffle);
    expect(repetitionCount(once)).toBe(2);
    expect(gameResult(once[once.length - 1]!, once)).toEqual({ status: 'ongoing' });
    const twice = history(start, [...shuffle, ...shuffle]);
    expect(repetitionCount(twice)).toBe(3);
    expect(gameResult(twice[twice.length - 1]!, twice)).toEqual({ status: 'draw', reason: 'repetition' });
  });

  it('ilma ajaloota kordust ei kontrollita', () => {
    const twice = history(start, [...shuffle, ...shuffle]);
    expect(gameResult(twice[twice.length - 1]!)).toEqual({ status: 'ongoing' });
    expect(repetitionCount([])).toBe(0);
  });
});

describe('3 tammi ühe tammi vastu', () => {
  it('tunneb sellise lõppmängu ära', () => {
    expect(isLoneKingEnding(setupPosition({ whiteKings: ['a1', 'c1', 'e1'], blackKings: ['h8'] }).board)).toBe(true);
    expect(isLoneKingEnding(setupPosition({ blackKings: ['a1', 'c1', 'e1', 'g1'], whiteKings: ['h8'] }).board)).toBe(true);
    // Kaks tammi, lihtnupp tugevamal poolel või lihtnupp nõrgemal poolel ei loe.
    expect(isLoneKingEnding(setupPosition({ whiteKings: ['a1', 'c1'], blackKings: ['h8'] }).board)).toBe(false);
    expect(isLoneKingEnding(setupPosition({ whiteKings: ['a1', 'c1', 'e1'], white: ['g1'], blackKings: ['h8'] }).board)).toBe(false);
    expect(isLoneKingEnding(setupPosition({ whiteKings: ['a1', 'c1', 'e1'], black: ['h8'] }).board)).toBe(false);
    expect(isLoneKingEnding(initialPosition().board)).toBe(false);
  });

  it('loendab käike ja 15 tugevama poole käigu järel on viik', () => {
    let pos = setupPosition({ whiteKings: ['a1', 'c1', 'e1'], blackKings: ['h8'] });
    pos = play(pos, 'a1-b2');
    expect(pos.loneKingPlies).toBe(1);
    expect(gameResult({ ...pos, loneKingPlies: DRAW_LONE_KING_PLIES - 1 }).status).toBe('ongoing');
    expect(gameResult({ ...pos, loneKingPlies: DRAW_LONE_KING_PLIES })).toEqual({ status: 'draw', reason: 'lone-king' });
  });

  it('loendur nullitakse, kui seis pole enam selline', () => {
    // Valge lööb musta lihtnupu ja tekib 3 vs 1.
    let pos = setupPosition({ whiteKings: ['a1', 'c1', 'e1'], blackKings: ['h8'], black: ['b2'] });
    expect(pos.loneKingPlies ?? 0).toBe(0);
    pos = play(pos, 'a1:c3');
    expect(pos.loneKingPlies).toBe(1);
    const notLone = play(setupPosition({ whiteKings: ['a1', 'c1'], blackKings: ['h8'] }), 'a1-b2');
    expect(notLone.loneKingPlies).toBe(0);
  });
});
