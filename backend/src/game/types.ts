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
  /**
   * Järjestikused käigud seisus, kus ühel poolel on vähemalt 3 tammi ja teisel
   * ainult üks tamm (vene kabe: tugevam pool peab võitma 15 käiguga).
   * Puudumine tähendab 0.
   */
  loneKingPlies?: number;
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
  /** no-moves = vastasel pole käike, time = vastase kell sai otsa, resign = vastane alistus. */
  | { status: 'win'; winner: Color; reason: WinReason }
  | { status: 'draw'; reason: DrawReason };

/** puzzle = ülesanne lahendati (inimene võitis) või ebaõnnestus (arvuti võitis). */
export type WinReason = 'no-moves' | 'time' | 'resign' | 'puzzle';
/**
 * king-moves = 30 tammikäiku ilma löömiseta, repetition = sama seis kolmandat korda,
 * lone-king = 3+ tammi ei võitnud üksikut tammi 15 käiguga, agreement = kokkulepe.
 */
export type DrawReason = 'king-moves' | 'repetition' | 'lone-king' | 'agreement';

export function opponent(color: Color): Color {
  return color === 'white' ? 'black' : 'white';
}
