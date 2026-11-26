/**
 * Kabe AI vastane: negamax alfa-beeta kärpimisega.
 *
 * Tasemed:
 * - beginner: otsib 2 poolkäiku sügavale ja valib juhuslikult hea käigu hulgast,
 *   nii et teeb vahel vigu.
 * - medium: otsib 4 poolkäiku sügavale.
 * - strong: otsib 7 poolkäiku sügavale ja jätkab löömisseisudes otsingut
 *   (vaikuse otsing), et mitte jätta nuppu lüüa.
 *
 * Otsing on iteratiivne (sügavus 1, 2, ...) ja ajapiiranguga: kui aeg saab otsa,
 * kasutatakse viimase lõpuni jõudnud sügavuse tulemust. Nii ei jää laud kunagi
 * kauaks ootama, ka keerulises seisus.
 */
import { DRAW_LONE_KING_PLIES, DRAW_QUIET_KING_PLIES, applyMove, legalMoves } from '../game/rules.js';
import { rankOf } from '../game/squares.js';
import type { Color, Move, Position } from '../game/types.js';

export type AiLevel = 'beginner' | 'medium' | 'strong';

export interface AiOptions {
  level: AiLevel;
  /** Juhuarvude allikas (0 ≤ x < 1). Testides saab anda deterministliku. */
  random?: () => number;
  /** Mõtlemisaja ülempiir millisekundites (vaikimisi DEFAULT_TIME_MS). */
  timeMs?: number;
  /** Kella allikas (testides). */
  now?: () => number;
}

export interface SearchOptions {
  timeMs?: number;
  now?: () => number;
}

/** Vaikimisi mõtlemisaeg: laud ja äpp ei pea kauem ootama. */
export const DEFAULT_TIME_MS = 1000;

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
/** Mitme sõlme tagant kella vaadatakse. */
const CLOCK_INTERVAL = 512;

class OutOfTime extends Error {}

/** Otsingu ajapiirang. */
class Budget {
  private nodes = 0;
  constructor(
    private readonly deadline: number,
    private readonly now: () => number,
  ) {}
  tick(): void {
    if (++this.nodes % CLOCK_INTERVAL === 0 && this.now() >= this.deadline) throw new OutOfTime();
  }
}

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

function quiescence(position: Position, alpha: number, beta: number, plies: number, budget: Budget): number {
  budget.tick();
  const moves = legalMoves(position);
  if (moves.length === 0) return -WIN_SCORE + plies;
  const isCapture = (moves[0]?.captures.length ?? 0) > 0;
  if (!isCapture || plies >= MAX_QUIESCENCE_PLIES) return relative(position, position.turn);
  // Löömine on kohustuslik, seega "seisma jäämise" hinnangut siin pole.
  let best = -Infinity;
  for (const move of ordered(moves)) {
    const score = -quiescence(applyMove(position, move), -beta, -alpha, plies + 1, budget);
    if (score > best) best = score;
    if (score > alpha) alpha = score;
    if (alpha >= beta) break;
  }
  return best;
}

function negamax(
  position: Position,
  depth: number,
  alpha: number,
  beta: number,
  plies: number,
  cfg: LevelConfig,
  budget: Budget,
): number {
  budget.tick();
  const moves = legalMoves(position);
  if (moves.length === 0) return -WIN_SCORE + plies; // käijal pole käiku; kiirem võit on parem
  if (position.quietKingPlies >= DRAW_QUIET_KING_PLIES) return 0;
  if ((position.loneKingPlies ?? 0) >= DRAW_LONE_KING_PLIES) return 0;
  if (depth === 0) {
    return cfg.quiescence ? quiescence(position, alpha, beta, plies, budget) : relative(position, position.turn);
  }
  let best = -Infinity;
  for (const move of ordered(moves)) {
    const score = -negamax(applyMove(position, move), depth - 1, -beta, -alpha, plies + 1, cfg, budget);
    if (score > best) best = score;
    if (score > alpha) alpha = score;
    if (alpha >= beta) break;
  }
  return best;
}

export interface RankedMoves {
  choices: AiChoice[];
  /** Sügavus, milleni otsing lõpuni jõudis. */
  depth: number;
}

/**
 * Hindab kõik seaduslikud käigud, parim esimesena. Sügavust suurendatakse
 * järk-järgult; kui aeg saab otsa, jääb kehtima viimane lõpetatud sügavus.
 * Sügavus 1 lõpetatakse alati, et käik oleks olemas.
 */
export function searchMoves(position: Position, level: AiLevel, options: SearchOptions = {}): RankedMoves {
  const cfg = LEVELS[level];
  const now = options.now ?? Date.now;
  const budget = new Budget(now() + (options.timeMs ?? DEFAULT_TIME_MS), now);
  const unlimited = new Budget(Infinity, now);
  let choices: AiChoice[] = legalMoves(position).map((move) => ({ move, score: 0 }));
  let done = 0;
  for (let depth = 1; depth <= cfg.depth && choices.length > 0; depth++) {
    try {
      const next = choices.map(({ move }) => ({
        move,
        score: -negamax(applyMove(position, move), depth - 1, -Infinity, Infinity, 1, cfg, depth === 1 ? unlimited : budget),
      }));
      // Stabiilne sortimine: võrdsete puhul jääb eelmise sügavuse järjekord.
      choices = next.sort((a, b) => b.score - a.score);
      done = depth;
    } catch (error) {
      if (error instanceof OutOfTime) break;
      throw error;
    }
  }
  return { choices, depth: done };
}

/** Hindab kõik seaduslikud käigud, parim esimesena. */
export function rankMoves(position: Position, level: AiLevel, options: SearchOptions = {}): AiChoice[] {
  return searchMoves(position, level, options).choices;
}

/** Valib AI käigu. Tagastab null, kui käike pole (mäng on läbi). */
export function chooseMove(position: Position, options: AiOptions): AiChoice | null {
  const searchOptions: SearchOptions = {};
  if (options.timeMs !== undefined) searchOptions.timeMs = options.timeMs;
  if (options.now) searchOptions.now = options.now;
  const ranked = rankMoves(position, options.level, searchOptions);
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
