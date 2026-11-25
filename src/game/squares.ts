/**
 * Tumedate ruutude numeratsioon 0–31.
 *
 * Indeks vastab laua reed-lülitite järjekorrale ja bitile, mille Arduino
 * saadab: MCP23017 #1 (0x20) GPA0–GPA7 = 0–7, GPB0–GPB7 = 8–15,
 * MCP23017 #2 (0x21) GPA0–GPA7 = 16–23, GPB0–GPB7 = 24–31.
 *
 *   0 = a1, 1 = c1, 2 = e1, 3 = g1, 4 = b2, 5 = d2, ... 31 = h8
 */
export type Square = number;

export const SQUARE_COUNT = 32;
const FILES = 'abcdefgh';

/** Faili (0–7) ja rea (0–7) järgi ruudu indeks või null, kui ruut on hele või väljaspool lauda. */
export function toSquare(file: number, rank: number): Square | null {
  if (file < 0 || file > 7 || rank < 0 || rank > 7) return null;
  if ((file + rank) % 2 !== 0) return null;
  return rank * 4 + Math.floor(file / 2);
}

export function fileOf(sq: Square): number {
  const rank = rankOf(sq);
  return (sq % 4) * 2 + (rank % 2);
}

export function rankOf(sq: Square): number {
  return Math.floor(sq / 4);
}

export function isValidSquare(sq: number): sq is Square {
  return Number.isInteger(sq) && sq >= 0 && sq < SQUARE_COUNT;
}

/** Ruudu nimi, näiteks 0 -> "a1". */
export function squareName(sq: Square): string {
  if (!isValidSquare(sq)) throw new RangeError(`Vigane ruut: ${sq}`);
  return `${FILES[fileOf(sq)]}${rankOf(sq) + 1}`;
}

/** Ruudu nimi indeksiks, näiteks "d4" -> 13. Tagastab null heleda või vigase nime korral. */
export function parseSquare(name: string): Square | null {
  const m = /^([a-h])([1-8])$/.exec(name.trim().toLowerCase());
  if (!m || !m[1] || !m[2]) return null;
  return toSquare(FILES.indexOf(m[1]), Number(m[2]) - 1);
}

/** Diagonaalsuunad [failimuutus, reamuutus]. */
export const DIRECTIONS: ReadonlyArray<readonly [number, number]> = [
  [1, 1],
  [-1, 1],
  [1, -1],
  [-1, -1],
];

/** Järgmine ruut antud suunas või null, kui laud saab otsa. */
export function step(sq: Square, df: number, dr: number): Square | null {
  return toSquare(fileOf(sq) + df, rankOf(sq) + dr);
}
