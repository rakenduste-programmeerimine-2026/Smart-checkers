import type { Square } from './squares.js';

export type Color = 'white' | 'black';

export interface Piece {
  color: Color;
  king: boolean;
}

/** 32 tumedat ruutu, igaühel nupp või null. */
export type Board = ReadonlyArray<Piece | null>;

export interface Position {
  board: Board;
  turn: Color;
  /** Järjestikused tammikäigud ilma löömise ja lihtnupu käiguta (viigireegli jaoks). */
  quietKingPlies: number;
}

export interface Move {
  from: Square;
  /** Kõik maandumisruudud järjekorras; viimane on lõppruut. */
  path: Square[];
  /** Löödud vastase nupud löömise järjekorras. */
  captures: Square[];
  /** Kas lihtnupp saab käigu jooksul tammiks. */
  promotes: boolean;
}

export type GameResult =
  | { status: 'ongoing' }
  | { status: 'win'; winner: Color; reason: 'no-moves' }
  | { status: 'draw'; reason: 'king-moves' };

export function opponent(color: Color): Color {
  return color === 'white' ? 'black' : 'white';
}
