/**
 * Kabe AI vastane: negamax alfa-beeta kärpimisega.
 *
 * Tasemed:
 * - beginner: otsib 2 poolkäiku sügavale ja valib juhuslikult hea käigu hulgast,
 *   nii et teeb vahel vigu.
 * - medium: otsib 4 poolkäiku sügavale.
 * - strong: otsib 7 poolkäiku sügavale ja jätkab löömisseisudes otsingut
 *   (vaikuse otsing), et mitte jätta nuppu lüüa.
 */
import { DRAW_QUIET_KING_PLIES, applyMove, legalMoves } from './rules.js';
import { rankOf } from './squares.js';
import type { Color, Move, Position } from './types.js';

export type AiLevel = 'beginner' | 'medium' | 'strong';

export interface AiOptions {
  level: AiLevel;
  /** Juhuarvude allikas (0 ≤ x < 1). Testides saab anda deterministliku. */
  random?: () => number;
}

export interface AiChoice {
  move: Move;
  /** Hinnang käija vaatenurgast (positiivne = käijale hea). */
  score: number;
}

interface LevelConfig {
  depth: number;
  quiescence: boolean;
  /** Kui palju võib käik parimast halvem olla, et seda juhuslikult valida. */
  tolerance: number;
}

const LEVELS: Record<AiLevel, LevelConfig> = {
  beginner: { depth: 2, quiescence: false, tolerance: 120 },
  medium: { depth: 4, quiescence: true, tolerance: 0 },
  strong: { depth: 7, quiescence: true, tolerance: 0 },
};

export const MAN_VALUE = 100;
export const KING_VALUE = 300;
const WIN_SCORE = 100_000;
const MAX_QUIESCENCE_PLIES = 8;

/** Seisu hinnang valge vaatenurgast. */
export function evaluate(position: Position): number {
  let score = 0;
  position.board.forEach((piece, sq) => {
    if (!piece) return;
    const sign = piece.color === 'white' ? 1 : -1;
    if (piece.king) {
      score += sign * KING_VALUE;
      return;
    }
    // Edasi liikunud lihtnupp on väärtuslikum, sest on tammiks saamisele lähemal.
    const advance = piece.color === 'white' ? rankOf(sq) : 7 - rankOf(sq);
    // Tagumine rida kaitseb vastase tammiks saamise eest.
    const backRank = advance === 0 ? 4 : 0;
    score += sign * (MAN_VALUE + advance * 3 + backRank);
  });
  return score;
}

const relative = (position: Position, color: Color): number =>
  color === 'white' ? evaluate(position) : -evaluate(position);

/** Löömised enne vaiksemaid, pikemad löömisseeriad enne lühemaid (parem kärpimine). */
function ordered(moves: Move[]): Move[] {
  return [...moves].sort((a, b) => b.captures.length - a.captures.length || Number(b.promotes) - Number(a.promotes));
}

function quiescence(position: Position, alpha: number, beta: number, plies: number): number {
  const moves = legalMoves(position);
  if (moves.length === 0) return -WIN_SCORE + plies;
  const isCapture = (moves[0]?.captures.length ?? 0) > 0;
  if (!isCapture || plies >= MAX_QUIESCENCE_PLIES) return relative(position, position.turn);
  // Löömine on kohustuslik, seega "seisma jäämise" hinnangut siin pole.
  let best = -Infinity;
  for (const move of ordered(moves)) {
    const score = -quiescence(applyMove(position, move), -beta, -alpha, plies + 1);
    if (score > best) best = score;
    if (score > alpha) alpha = score;
    if (alpha >= beta) break;
  }
  return best;
}

function negamax(position: Position, depth: number, alpha: number, beta: number, plies: number, cfg: LevelConfig): number {
  const moves = legalMoves(position);
  if (moves.length === 0) return -WIN_SCORE + plies; // käijal pole käiku; kiirem võit on parem
  if (position.quietKingPlies >= DRAW_QUIET_KING_PLIES) return 0;
  if (depth === 0) {
    return cfg.quiescence ? quiescence(position, alpha, beta, plies) : relative(position, position.turn);
  }
  let best = -Infinity;
  for (const move of ordered(moves)) {
    const score = -negamax(applyMove(position, move), depth - 1, -beta, -alpha, plies + 1, cfg);
    if (score > best) best = score;
    if (score > alpha) alpha = score;
    if (alpha >= beta) break;
  }
  return best;
}

/** Hindab kõik seaduslikud käigud, parim esimesena. */
export function rankMoves(position: Position, level: AiLevel): AiChoice[] {
  const cfg = LEVELS[level];
  const choices = legalMoves(position).map((move) => ({
    move,
    score: -negamax(applyMove(position, move), cfg.depth - 1, -Infinity, Infinity, 1, cfg),
  }));
  return choices.sort((a, b) => b.score - a.score);
}

/** Valib AI käigu. Tagastab null, kui käike pole (mäng on läbi). */
export function chooseMove(position: Position, options: AiOptions): AiChoice | null {
  const ranked = rankMoves(position, options.level);
  const best = ranked[0];
  if (!best) return null;
  const tolerance = LEVELS[options.level].tolerance;
  if (tolerance === 0) return best;
  const pool = ranked.filter((c) => c.score >= best.score - tolerance);
  const random = options.random ?? Math.random;
  return pool[Math.min(pool.length - 1, Math.floor(random() * pool.length))] ?? best;
}

/** Vihje mängijale: keskmise taseme parim käik (kiire ja piisavalt hea). */
export function suggestMove(position: Position): AiChoice | null {
  return chooseMove(position, { level: 'medium' });
}
