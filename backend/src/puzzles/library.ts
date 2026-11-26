/**
 * Kabeülesanded: seis, kus käigul olev pool saab parima käiguga eelise.
 *
 * Iga ülesande juures on mootori leitud lahendus. Mängus loetakse õigeks see
 * käik või mõni teine, mida mootor peab sama heaks (kuni PUZZLE_TOLERANCE
 * võrra halvem, vt GameStore). Lisaks saab ülesandeid teha mängija enda vigadest.
 */
import { setupPosition, type SetupOptions } from '../game/rules.js';
import type { Color, Position } from '../game/types.js';
import type { GameReview } from '../analysis/review.js';
import type { NewGameOptions } from '../server/games.js';

export type Difficulty = 'easy' | 'medium' | 'hard';

export interface PuzzleDef {
  id: string;
  title: string;
  difficulty: Difficulty;
  /** Mitu õiget käiku järjest tuleb leida (vastase vastuse teeb arvuti). */
  goalMoves: number;
  /** Esimese käigu lahendus. */
  solution: string;
  position: Position;
  /** Kust ülesanne pärineb: kogust või mängija mängust. */
  source: { kind: 'library' } | { kind: 'game'; gameId: string; ply: number };
}

export const MAX_CUSTOM_PUZZLES = 200;

const define = (
  id: string,
  title: string,
  difficulty: Difficulty,
  solution: string,
  setup: SetupOptions & { turn: Color },
): PuzzleDef => ({ id, title, difficulty, goalMoves: 1, solution, position: setupPosition(setup), source: { kind: 'library' } });

/** Sisseehitatud ülesanded (kontrollitud testis: parim käik on selgelt parem kui teised). */
export const BUILTIN_PUZZLES: PuzzleDef[] = [
  define('p01', 'Must käib ja võidab', 'easy', 'b6-c5', {
    white: ['a1', 'g1', 'b2', 'h2', 'c3', 'e3', 'g3', 'b4', 'd4', 'f4'], black: ['a5', 'e5', 'b6', 'd6', 'f6', 'a7', 'g7', 'd8', 'f8', 'h8'], turn: 'black',
  }),
  define('p02', 'Must käib ja võidab', 'easy', 'b6-c5', {
    white: ['a1', 'e1', 'g1', 'b2', 'd2', 'f2', 'c3', 'e3', 'g3', 'b4', 'd4', 'h4'], black: ['a5', 'g5', 'b6', 'd6', 'f6', 'h6', 'a7', 'c7', 'e7', 'd8', 'f8', 'h8'], turn: 'black',
  }),
  define('p03', 'Valge käib ja võidab', 'easy', 'e1-f2', {
    white: ['a1', 'c1', 'e1', 'g1', 'b2', 'd2', 'h2', 'a3', 'g3', 'b4', 'f4', 'a5'], black: ['e5', 'g5', 'b6', 'd6', 'h6', 'c7', 'e7', 'g7', 'b8', 'f8', 'h8'], turn: 'white',
  }),
  define('p04', 'Must käib ja võidab', 'medium', 'c5-d4', {
    white: ['e1', 'g1', 'b2', 'd2', 'f2', 'a3', 'e3', 'g3', 'f4', 'a5'], black: ['h4', 'c5', 'g5', 'd6', 'h6', 'a7', 'c7', 'd8', 'f8', 'h8'], turn: 'black',
  }),
  define('p05', 'Valge käib ja võidab', 'medium', 'f4-e5', {
    white: ['a1', 'e1', 'b2', 'd2', 'f2', 'h2', 'a3', 'c3', 'b4', 'f4'], black: ['h4', 'a5', 'c5', 'd6', 'f6', 'a7', 'c7', 'e7', 'd8', 'f8'], turn: 'white',
  }),
  define('p06', 'Valge käib ja võidab', 'medium', 'h4-g5', {
    white: ['a1', 'c1', 'e1', 'g1', 'd2', 'f2', 'h2', 'c3', 'b4', 'd4', 'h4', 'c5'], black: ['f4', 'a5', 'b6', 'd6', 'f6', 'h6', 'a7', 'e7', 'g7', 'd8', 'f8', 'h8'], turn: 'white',
  }),
  define('p07', 'Valge käib ja võidab', 'medium', 'f2-g3', {
    white: ['a1', 'e1', 'g1', 'd2', 'f2', 'h2', 'd4', 'c5', 'g5'], black: ['h4', 'a5', 'f6', 'a7', 'c7', 'e7', 'b8', 'f8', 'h8'], turn: 'white',
  }),
  define('p08', 'Must käib ja võidab', 'medium', 'e5-d4', {
    white: ['c1', 'e1', 'g1', 'b2', 'd2', 'h2', 'a3', 'c3', 'e3', 'g3', 'b4', 'c5'], black: ['a5', 'e5', 'g5', 'd6', 'f6', 'h6', 'a7', 'e7', 'b8', 'd8', 'f8', 'h8'], turn: 'black',
  }),
  define('p09', 'Must käib ja võidab', 'medium', 'd8-c7', {
    white: ['c1', 'g1', 'b2', 'd2', 'f2', 'h2', 'a3', 'c3', 'e3', 'b4', 'd4', 'f4'], black: ['h4', 'a5', 'g5', 'b6', 'd6', 'f6', 'a7', 'e7', 'b8', 'd8', 'f8', 'h8'], turn: 'black',
  }),
  define('p10', 'Valge käib ja võidab', 'hard', 'b4-c5', {
    white: ['a1', 'c1', 'e1', 'g1', 'f2', 'h2', 'c3', 'g3', 'b4', 'd4', 'f4', 'a5'], black: ['h4', 'e5', 'b6', 'd6', 'f6', 'h6', 'a7', 'c7', 'e7', 'g7', 'b8', 'h8'], turn: 'white',
  }),
  define('p11', 'Valge käib ja võidab', 'hard', 'd2-e3', {
    white: ['a1', 'b2', 'd2', 'h2', 'a3', 'c3', 'h4'], black: ['d4', 'a5', 'e5', 'h6', 'a7', 'g7'], turn: 'white',
  }),
  define('p12', 'Must käib ja võidab', 'hard', 'e7-f6', {
    white: ['c1', 'e1', 'b2', 'd2', 'a3', 'g7'], black: ['a5', 'g5', 'd6', 'h6', 'c7', 'e7', 'b8', 'f8'], turn: 'black',
  }),
];

/**
 * Ülesande mängu seaded: mäng algab ülesande seisust, inimene on käigul olev
 * pool ja vastu mängib tugev mootor.
 */
export function puzzleGame(puzzle: PuzzleDef): NewGameOptions {
  return {
    opponent: 'engine',
    level: 'strong',
    humanColor: puzzle.position.turn,
    start: puzzle.position,
    puzzle: { id: puzzle.id, title: puzzle.title, goalMoves: puzzle.goalMoves, expected: puzzle.solution },
  };
}

export class PuzzleLibrary {
  private readonly custom = new Map<string, PuzzleDef>();

  constructor(private readonly builtin: readonly PuzzleDef[] = BUILTIN_PUZZLES) {}

  list(): PuzzleDef[] {
    return [...this.builtin, ...this.custom.values()];
  }

  get(id: string): PuzzleDef | undefined {
    return this.builtin.find((p) => p.id === id) ?? this.custom.get(id);
  }

  /** Järgmine ülesanne kogus (laua menüü jaoks), ringiga. */
  next(afterId: string | null): PuzzleDef | undefined {
    const all = this.list();
    if (all.length === 0) return undefined;
    const i = afterId ? all.findIndex((p) => p.id === afterId) : -1;
    return all[(i + 1) % all.length];
  }

  /**
   * Teeb mängu ülevaate suurematest vigadest ülesanded: seis enne viga,
   * ülesanne on leida parem käik. Sama mängu kordne kutsumine ei tee topelt.
   */
  fromReview(gameId: string, positions: readonly Position[], review: GameReview): PuzzleDef[] {
    const made: PuzzleDef[] = [];
    for (const ply of review.keyMoments) {
      const id = `${gameId.slice(0, 8)}-${ply}`;
      const existing = this.custom.get(id);
      if (existing) {
        made.push(existing);
        continue;
      }
      const position = positions[ply];
      const reviewed = review.moves[ply];
      if (!position || !reviewed) continue;
      const puzzle: PuzzleDef = {
        id,
        title: `Sinu mäng, käik ${Math.floor(ply / 2) + 1}`,
        difficulty: reviewed.classification === 'blunder' ? 'easy' : 'medium',
        goalMoves: 1,
        solution: reviewed.best,
        position,
        source: { kind: 'game', gameId, ply },
      };
      if (this.custom.size >= MAX_CUSTOM_PUZZLES) {
        const oldest = this.custom.keys().next().value;
        if (oldest !== undefined) this.custom.delete(oldest);
      }
      this.custom.set(id, puzzle);
      made.push(puzzle);
    }
    return made;
  }
}

