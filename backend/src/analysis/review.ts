/**
 * Mänguülevaade: hindab mängu iga käiku ja leiab vead.
 *
 * Iga seisu jaoks otsib mootor kõik käigud läbi ja võrdleb tehtud käiku parimaga.
 * Kaotus (loss) on, mitu sentinuppu (100 = üks lihtnupp) tehtud käik parimast
 * halvem oli. Arvutus jagatakse osadeks, et server vahepeal teistele päringutele
 * (näiteks laua olekule) vastata jõuaks.
 */
import { formatMove } from '../game/rules.js';
import type { Color, Move, Position } from '../game/types.js';
import { searchMoves, type AiLevel } from '../ai/engine.js';

export type MoveClass = 'best' | 'good' | 'inaccuracy' | 'mistake' | 'blunder' | 'forced';

export interface ReviewedMove {
  ply: number;
  color: Color;
  move: string;
  best: string;
  /** Kui palju parimast halvem (sentinuppudes, ≥ 0). */
  loss: number;
  /** Hinnang pärast käiku valge vaatenurgast. */
  score: number;
  classification: MoveClass;
}

export interface SideSummary {
  /** 0–100: kui lähedal olid käigud parimale. */
  accuracy: number;
  inaccuracies: number;
  mistakes: number;
  blunders: number;
}

export interface GameReview {
  moves: ReviewedMove[];
  summary: Record<Color, SideSummary>;
  /** Suurima veaga käigud, suurimad eespool (kuni 3). */
  keyMoments: number[];
}

export interface ReviewOptions {
  level?: AiLevel;
  /** Mõtlemisaeg ühe seisu kohta (ms). */
  timePerMoveMs?: number;
  /** Kutsutakse iga käigu järel (testid ja edenemine). */
  yieldEvery?: () => Promise<void>;
}

/** Võidu hinnangud lõigatakse, et üks võiduseis ei moonutaks täpsust. */
const CLAMP = 1500;
const clamp = (x: number) => Math.max(-CLAMP, Math.min(CLAMP, x));

export const THRESHOLDS = { good: 30, inaccuracy: 80, mistake: 200 } as const;

export function classify(loss: number, forced: boolean): MoveClass {
  if (forced) return 'forced';
  if (loss <= 0) return 'best';
  if (loss < THRESHOLDS.good) return 'good';
  if (loss < THRESHOLDS.inaccuracy) return 'inaccuracy';
  if (loss < THRESHOLDS.mistake) return 'mistake';
  return 'blunder';
}

const nextTick = () => new Promise<void>((resolve) => setImmediate(resolve));

/** positions[i] on seis enne käiku moves[i]. */
export async function reviewGame(
  positions: readonly Position[],
  moves: readonly Move[],
  options: ReviewOptions = {},
): Promise<GameReview> {
  const level = options.level ?? 'medium';
  const timeMs = options.timePerMoveMs ?? 150;
  const pause = options.yieldEvery ?? nextTick;
  const reviewed: ReviewedMove[] = [];

  for (const [ply, move] of moves.entries()) {
    const position = positions[ply];
    if (!position) break;
    const { choices } = searchMoves(position, level, { timeMs });
    const text = formatMove(move);
    const best = choices[0];
    const played = choices.find((c) => formatMove(c.move) === text);
    const bestScore = clamp(best?.score ?? 0);
    const playedScore = clamp(played?.score ?? bestScore);
    const loss = Math.max(0, bestScore - playedScore);
    const sign = position.turn === 'white' ? 1 : -1;
    reviewed.push({
      ply,
      color: position.turn,
      move: text,
      best: best ? formatMove(best.move) : text,
      loss,
      score: sign * playedScore,
      classification: classify(loss, choices.length <= 1),
    });
    await pause();
  }

  const summary = { white: summarize(reviewed, 'white'), black: summarize(reviewed, 'black') };
  const keyMoments = reviewed
    .filter((m) => m.classification === 'mistake' || m.classification === 'blunder')
    .sort((a, b) => b.loss - a.loss)
    .slice(0, 3)
    .map((m) => m.ply);
  return { moves: reviewed, summary, keyMoments };
}

function summarize(moves: ReviewedMove[], color: Color): SideSummary {
  const own = moves.filter((m) => m.color === color && m.classification !== 'forced');
  const count = (c: MoveClass) => own.filter((m) => m.classification === c).length;
  // Täpsus: keskmine käigu "skoor", kus 0 kaotust = 100 ja 300+ kaotust = 0.
  const accuracy = own.length === 0 ? 100 : own.reduce((sum, m) => sum + Math.max(0, 100 - m.loss / 3), 0) / own.length;
  return {
    accuracy: Math.round(accuracy),
    inaccuracies: count('inaccuracy'),
    mistakes: count('mistake'),
    blunders: count('blunder'),
  };
}
