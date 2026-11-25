/**
 * Ühine liides AI vastastele: kohalik mootor (engine) ja väline AI API (claude).
 */
import { formatMove } from '../game/rules.js';
import type { Move, Position } from '../game/types.js';
import { chooseMove, type AiLevel } from './engine.js';

export type OpponentKind = 'engine' | 'claude';

export interface OpponentMove {
  move: Move;
  /** Käigu tekstikuju, näiteks "c3-d4". */
  notation: string;
  /** Kes käigu tegelikult valis. */
  source: OpponentKind;
  /** AI lühike põhjendus, kui see on olemas. */
  reason?: string;
  /** Kui väline AI ei vastanud, siis miks tehti käik kohaliku mootoriga. */
  fallbackReason?: string;
}

export interface Opponent {
  readonly kind: OpponentKind;
  /** Tagastab null, kui käiku pole (mäng on läbi). */
  chooseMove(position: Position, level: AiLevel): Promise<OpponentMove | null>;
}

export function createEngineOpponent(random?: () => number): Opponent {
  return {
    kind: 'engine',
    async chooseMove(position, level) {
      const choice = chooseMove(position, { level, random });
      if (!choice) return null;
      return { move: choice.move, notation: formatMove(choice.move), source: 'engine' };
    },
  };
}
