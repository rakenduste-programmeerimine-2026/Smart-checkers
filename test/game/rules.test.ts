import { describe, expect, it } from 'vitest';
import {
  DRAW_QUIET_KING_PLIES,
  applyMove,
  findMove,
  formatMove,
  gameResult,
  initialPosition,
  legalMoves,
  setupPosition,
} from '../../src/game/rules.js';
import { parseSquare, squareName } from '../../src/game/squares.js';
import type { Position } from '../../src/game/types.js';

const names = (pos: Position): string[] => legalMoves(pos).map(formatMove).sort();
const sq = (name: string): number => {
  const s = parseSquare(name);
  if (s === null) throw new Error(name);
  return s;
};

describe('algseis', () => {
  it('on 12 + 12 nuppu ja valge alustab', () => {
    const pos = initialPosition();
    expect(pos.board.filter((p) => p?.color === 'white')).toHaveLength(12);
    expect(pos.board.filter((p) => p?.color === 'black')).toHaveLength(12);
    expect(pos.turn).toBe('white');
  });

  it('valgel on 7 avakäiku', () => {
    expect(names(initialPosition())).toEqual(['a3-b4', 'c3-b4', 'c3-d4', 'e3-d4', 'e3-f4', 'g3-f4', 'g3-h4']);
  });
});

describe('lihtnupu käigud', () => {
  it('liigub ainult edasi', () => {
    expect(names(setupPosition({ white: ['d4'] }))).toEqual(['d4-c5', 'd4-e5']);
    expect(names(setupPosition({ black: ['d4'], turn: 'black' }))).toEqual(['d4-c3', 'd4-e3']);
  });

  it('saab viimasel real tammiks', () => {
    const pos = setupPosition({ white: ['g7'], black: ['a1'] });
    const move = findMove(pos, 'g7-h8')!;
    expect(move.promotes).toBe(true);
    expect(applyMove(pos, move).board[sq('h8')]).toEqual({ color: 'white', king: true });
  });
});

describe('löömine', () => {
  it('on kohustuslik', () => {
    expect(names(setupPosition({ white: ['c3', 'g3'], black: ['d4'] }))).toEqual(['c3:e5']);
  });

  it('lihtnupp lööb ka tagasi', () => {
    expect(names(setupPosition({ white: ['e5'], black: ['d4'] }))).toEqual(['e5:c3']);
  });

  it('seeria tuleb lõpuni viia', () => {
    expect(names(setupPosition({ white: ['c3'], black: ['d4', 'f6'] }))).toEqual(['c3:e5:g7']);
  });

  it('löömisvariandi võib valida vabalt (enamuse reeglit pole)', () => {
    expect(names(setupPosition({ white: ['c3'], black: ['b4', 'd4', 'f6'] }))).toEqual(['c3:a5', 'c3:e5:g7']);
  });

  it('eemaldab löödud nupud käigu lõpus', () => {
    const pos = setupPosition({ white: ['c3'], black: ['d4', 'f6', 'a7'] });
    const next = applyMove(pos, findMove(pos, 'c3:g7')!);
    expect(next.board[sq('d4')]).toBeNull();
    expect(next.board[sq('f6')]).toBeNull();
    expect(next.board[sq('g7')]).toEqual({ color: 'white', king: false });
    expect(next.turn).toBe('black');
  });

  it('lihtnupp saab löömise ajal tammiks ja jätkab tammina', () => {
    const pos = setupPosition({ white: ['f6'], black: ['e7', 'b6'] });
    const moves = legalMoves(pos);
    expect(moves.map(formatMove)).toEqual(['f6:d8:a5']);
    expect(moves[0]!.promotes).toBe(true);
    expect(applyMove(pos, moves[0]!).board[sq('a5')]).toEqual({ color: 'white', king: true });
  });
});

describe('tamm', () => {
  it('liigub suvalise kauguse peale', () => {
    const moves = names(setupPosition({ whiteKings: ['a1'], black: ['h8'] }));
    expect(moves).toEqual(['a1-b2', 'a1-c3', 'a1-d4', 'a1-e5', 'a1-f6', 'a1-g7']);
  });

  it('lööb kaugelt ja võib maanduda igale vabale ruudule löödud nupu taga', () => {
    expect(names(setupPosition({ whiteKings: ['a1'], black: ['c3'] }))).toEqual([
      'a1:d4',
      'a1:e5',
      'a1:f6',
      'a1:g7',
      'a1:h8',
    ]);
  });

  it('peab maanduma ruudule, kust saab edasi lüüa', () => {
    expect(names(setupPosition({ whiteKings: ['a1'], black: ['c3', 'f4'] }))).toEqual(['a1:e5:g3', 'a1:e5:h2']);
  });

  it('löödud nupp blokeerib tee ja seda ei saa teist korda lüüa', () => {
    const moves = legalMoves(setupPosition({ whiteKings: ['a1'], black: ['c3', 'e5'] }));
    expect(moves.map(formatMove).sort()).toEqual(['a1:d4:f6', 'a1:d4:g7', 'a1:d4:h8']);
    for (const m of moves) {
      expect(new Set(m.captures).size).toBe(m.captures.length);
      expect(m.captures.map(squareName).sort()).toEqual(['c3', 'e5']);
    }
  });
});

describe('mängu tulemus', () => {
  it('kaotab see, kellel pole käiku', () => {
    expect(gameResult(setupPosition({ white: ['a1'], black: [], turn: 'black' }))).toEqual({
      status: 'win',
      winner: 'white',
      reason: 'no-moves',
    });
    // Valge nupp a1 on blokeeritud: b2 on must ja c3 must katab löögi.
    expect(gameResult(setupPosition({ white: ['a1'], black: ['b2', 'c3'] })).status).toBe('win');
  });

  it('loeb ainult tammikäike viigireegli jaoks', () => {
    let pos = setupPosition({ whiteKings: ['a1'], blackKings: ['h8'] });
    pos = applyMove(pos, findMove(pos, 'a1-b2')!);
    expect(pos.quietKingPlies).toBe(1);
    expect(gameResult({ ...pos, quietKingPlies: DRAW_QUIET_KING_PLIES })).toEqual({
      status: 'draw',
      reason: 'king-moves',
    });
    const withMan = setupPosition({ white: ['c3'], blackKings: ['h8'] });
    expect(applyMove({ ...withMan, quietKingPlies: 10 }, findMove(withMan, 'c3-d4')!).quietKingPlies).toBe(0);
  });

  it('mäng käib algseisus', () => {
    expect(gameResult(initialPosition())).toEqual({ status: 'ongoing' });
  });
});

describe('käikude tekst', () => {
  it('leiab käigu täis- ja lühikujul', () => {
    const pos = setupPosition({ white: ['c3'], black: ['d4', 'f6'] });
    expect(formatMove(findMove(pos, 'c3:e5:g7')!)).toBe('c3:e5:g7');
    expect(formatMove(findMove(pos, 'c3:g7')!)).toBe('c3:e5:g7');
    expect(formatMove(findMove(pos, 'C3x g7'.replace(' ', ''))!)).toBe('c3:e5:g7');
  });

  it('tagastab null ebaseadusliku, vigase või mitmetähendusliku käigu korral', () => {
    const start = initialPosition();
    expect(findMove(start, 'c3-c4')).toBeNull();
    expect(findMove(start, 'b6-a5')).toBeNull();
    expect(findMove(start, 'jama')).toBeNull();
    // Tamm a1 võib lüüa c3 üle ja maanduda d4–h8; lühike "a1:h8" on üheselt mõistetav.
    expect(findMove(setupPosition({ whiteKings: ['a1'], black: ['c3'] }), 'a1:h8')).not.toBeNull();
  });
});
