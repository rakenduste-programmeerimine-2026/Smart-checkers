/**
 * Laua reed-lülitite oleku tõlgendamine.
 *
 * Laud saadab 32-bitise maski, kus bitt i = 1 tähendab, et ruudul i (vt squares.ts)
 * on nupp. Lülitid tunnevad ainult nupu olemasolu, mitte värvi ega tammi, seega
 * tuletatakse käik sellest, milline seaduslik käik annab täpselt sama hõivatuse.
 */
import { applyMove, legalMoves } from './rules.js';
import { SQUARE_COUNT, type Square } from './squares.js';
import type { Board, Move, Position } from './types.js';

export function occupancyMask(board: Board): number {
  let mask = 0;
  board.forEach((piece, sq) => {
    if (piece) mask |= 1 << sq;
  });
  return mask >>> 0;
}

export function squaresInMask(mask: number): Square[] {
  const out: Square[] = [];
  for (let sq = 0; sq < SQUARE_COUNT; sq++) if ((mask >>> sq) & 1) out.push(sq);
  return out;
}

export type Detection =
  /** Laud vastab praegusele seisule, käiku pole tehtud. */
  | { kind: 'unchanged' }
  /** Laud vastab ühe seadusliku käigu järgsele seisule. */
  | { kind: 'move'; move: Move }
  /**
   * Laud ei vasta ühelegi seisule. Võib olla pooleli käik (nupp on õhus) või viga.
   * `missing` = peaks olema nupp, aga pole; `extra` = ei peaks olema nuppu, aga on.
   */
  | { kind: 'mismatch'; missing: Square[]; extra: Square[] };

export function detectMove(position: Position, mask: number): Detection {
  const current = occupancyMask(position.board);
  const observed = mask >>> 0;
  if (observed === current) return { kind: 'unchanged' };
  for (const move of legalMoves(position)) {
    // Sama hõivatusega käigud (sama algus, lõpp ja löödud nupud) annavad sama seisu.
    if (occupancyMask(applyMove(position, move).board) === observed) return { kind: 'move', move };
  }
  return {
    kind: 'mismatch',
    missing: squaresInMask(current & ~observed),
    extra: squaresInMask(observed & ~current),
  };
}

/** Kontrollib, kas laud vastab oodatud seisule (näiteks pärast AI käigu tegemist laual). */
export function diffAgainst(board: Board, mask: number): { missing: Square[]; extra: Square[] } {
  const expected = occupancyMask(board);
  const observed = mask >>> 0;
  return {
    missing: squaresInMask(expected & ~observed),
    extra: squaresInMask(observed & ~expected),
  };
}
