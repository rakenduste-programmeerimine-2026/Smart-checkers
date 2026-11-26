/**
 * Kabe (vene kabe) reeglid, mida Eestis tavaliselt mängitakse:
 *
 * - 8×8 laud, mängitakse tumedatel ruutudel, valge alustab.
 * - Lihtnupp liigub ühe ruudu võrra diagonaalis edasi, lüüa saab nii edasi kui tagasi.
 * - Löömine on kohustuslik, aga löömisvariandi võib valida vabalt (enamuse reeglit pole).
 *   Alustatud löömisseeria tuleb lõpuni viia.
 * - Tamm ("lendav tamm") liigub ja lööb diagonaalis suvalise kauguse peale.
 *   Kui löögi järel saab mõnelt maandumisruudult edasi lüüa, peab maanduma sellisele ruudule.
 * - Löödud nupud eemaldatakse alles käigu lõpus ja sama nuppu ei saa kaks korda lüüa
 *   ("türgi löögi" keeld).
 * - Lihtnupp, kes jõuab löömise ajal viimasele reale, saab kohe tammiks ja jätkab tammina.
 * - Kaotab see, kellel pole käiku. Viik, kui 15 käiku järjest (30 poolkäiku)
 *   liigutatakse ainult tamme ilma löömiseta.
 */
import { DIRECTIONS, SQUARE_COUNT, parseSquare, rankOf, squareName, step, type Square } from './squares.js';
import { opponent, type Board, type Color, type GameResult, type Move, type Piece, type Position } from './types.js';

export const DRAW_QUIET_KING_PLIES = 30;
/** 3+ tammi ühe tammi vastu: 15 tugevama poole käiku = 30 poolkäiku. */
export const DRAW_LONE_KING_PLIES = 30;
/** Mitmendal kordusel on viik. */
export const DRAW_REPETITIONS = 3;

const forwardRank = (color: Color): number => (color === 'white' ? 1 : -1);
const isLastRank = (sq: Square, color: Color): boolean => rankOf(sq) === (color === 'white' ? 7 : 0);

export function initialPosition(): Position {
  const board: (Piece | null)[] = Array.from({ length: SQUARE_COUNT }, () => null);
  for (let sq = 0; sq < 12; sq++) board[sq] = { color: 'white', king: false };
  for (let sq = 20; sq < 32; sq++) board[sq] = { color: 'black', king: false };
  return { board, turn: 'white', quietKingPlies: 0 };
}

export interface SetupOptions {
  white?: string[];
  black?: string[];
  whiteKings?: string[];
  blackKings?: string[];
  turn?: Color;
}

/** Seis ruudunimede järgi, kasulik testides ja analüüsis. */
export function setupPosition(opts: SetupOptions): Position {
  const board: (Piece | null)[] = Array.from({ length: SQUARE_COUNT }, () => null);
  const place = (names: string[] | undefined, color: Color, king: boolean): void => {
    for (const name of names ?? []) {
      const sq = parseSquare(name);
      if (sq === null) throw new Error(`Vigane või hele ruut: ${name}`);
      if (board[sq]) throw new Error(`Ruut ${name} on juba hõivatud`);
      board[sq] = { color, king };
    }
  };
  place(opts.white, 'white', false);
  place(opts.black, 'black', false);
  place(opts.whiteKings, 'white', true);
  place(opts.blackKings, 'black', true);
  return { board, turn: opts.turn ?? 'white', quietKingPlies: 0 };
}

/** Kõik seaduslikud käigud. Kui mõni löömine on võimalik, tagastatakse ainult löömised. */
export function legalMoves(position: Position): Move[] {
  const captures: Move[] = [];
  const quiet: Move[] = [];
  position.board.forEach((piece, sq) => {
    if (!piece || piece.color !== position.turn) return;
    captures.push(...captureMovesFrom(position.board, sq, piece));
  });
  if (captures.length > 0) return dedupe(captures);
  position.board.forEach((piece, sq) => {
    if (!piece || piece.color !== position.turn) return;
    quiet.push(...quietMovesFrom(position.board, sq, piece));
  });
  return quiet;
}

function quietMovesFrom(board: Board, from: Square, piece: Piece): Move[] {
  const moves: Move[] = [];
  for (const [df, dr] of DIRECTIONS) {
    if (!piece.king) {
      if (dr !== forwardRank(piece.color)) continue;
      const to = step(from, df, dr);
      if (to !== null && !board[to]) {
        moves.push({ from, path: [to], captures: [], promotes: isLastRank(to, piece.color) });
      }
      continue;
    }
    let to = step(from, df, dr);
    while (to !== null && !board[to]) {
      moves.push({ from, path: [to], captures: [], promotes: false });
      to = step(to, df, dr);
    }
  }
  return moves;
}

function captureMovesFrom(original: Board, from: Square, piece: Piece): Move[] {
  // Liikuv nupp tõstetakse lähteruudult ära, et sinna saaks seeria jooksul tagasi maanduda.
  const board = original.slice();
  board[from] = null;
  const results: Move[] = [];

  const jumps = (pos: Square, king: boolean, captured: Square[]): Array<{ over: Square; landings: Square[] }> => {
    const found: Array<{ over: Square; landings: Square[] }> = [];
    for (const [df, dr] of DIRECTIONS) {
      let target = step(pos, df, dr);
      if (king) {
        while (target !== null && !board[target]) target = step(target, df, dr);
      }
      if (target === null) continue;
      const victim = board[target];
      // Löödud nupud jäävad lauale kuni käigu lõpuni ja blokeerivad tee.
      if (!victim || victim.color === piece.color || captured.includes(target)) continue;
      const landings: Square[] = [];
      let land = step(target, df, dr);
      while (land !== null && !board[land]) {
        landings.push(land);
        if (!king) break;
        land = step(land, df, dr);
      }
      if (landings.length > 0) found.push({ over: target, landings });
    }
    return found;
  };

  const search = (pos: Square, king: boolean, captured: Square[], path: Square[], promoted: boolean): void => {
    const options = jumps(pos, king, captured);
    if (options.length === 0) {
      if (captured.length > 0) results.push({ from, path, captures: captured, promotes: promoted });
      return;
    }
    for (const { over, landings } of options) {
      const nextCaptured = [...captured, over];
      const kingAt = (land: Square): boolean => king || isLastRank(land, piece.color);
      // Tamm peab maanduma ruudule, kust saab edasi lüüa, kui selline on olemas.
      const continuing = landings.filter((land) => jumps(land, kingAt(land), nextCaptured).length > 0);
      const allowed = continuing.length > 0 ? continuing : landings;
      for (const land of allowed) {
        const nowKing = kingAt(land);
        search(land, nowKing, nextCaptured, [...path, land], promoted || (nowKing && !piece.king));
      }
    }
  };

  search(from, piece.king, [], [], false);
  return results;
}

function dedupe(moves: Move[]): Move[] {
  const seen = new Set<string>();
  return moves.filter((m) => {
    const key = `${m.from}|${m.path.join(',')}|${[...m.captures].sort((a, b) => a - b).join(',')}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function finalSquare(move: Move): Square {
  const last = move.path[move.path.length - 1];
  if (last === undefined) throw new Error('Käigul puudub sihtruut');
  return last;
}

/** Teeb käigu ja tagastab uue seisu. Ei kontrolli seaduslikkust, selleks on legalMoves/findMove. */
export function applyMove(position: Position, move: Move): Position {
  const board = position.board.slice();
  const piece = board[move.from];
  if (!piece) throw new Error(`Ruudul ${squareName(move.from)} pole nuppu`);
  board[move.from] = null;
  for (const sq of move.captures) board[sq] = null;
  board[finalSquare(move)] = { color: piece.color, king: piece.king || move.promotes };
  const quiet = move.captures.length === 0 && piece.king;
  return {
    board,
    turn: opponent(position.turn),
    quietKingPlies: quiet ? position.quietKingPlies + 1 : 0,
    loneKingPlies: isLoneKingEnding(board) ? (position.loneKingPlies ?? 0) + 1 : 0,
  };
}

/** Kas ühel poolel on vähemalt 3 tammi (ja ainult tammid) ning teisel üks tamm. */
export function isLoneKingEnding(board: Board): boolean {
  const count = (color: 'white' | 'black') => {
    let kings = 0;
    let men = 0;
    for (const p of board) if (p?.color === color) p.king ? kings++ : men++;
    return { kings, men };
  };
  const w = count('white');
  const b = count('black');
  const lone = (x: typeof w) => x.kings === 1 && x.men === 0;
  const strong = (x: typeof w) => x.kings >= 3 && x.men === 0;
  return (lone(w) && strong(b)) || (lone(b) && strong(w));
}

/** Seisu võti korduste leidmiseks (laud ja käigul olev pool). */
export function positionKey(position: Position): string {
  let key = position.turn === 'white' ? 'w' : 'b';
  for (const p of position.board) key += p ? (p.color === 'white' ? (p.king ? 'W' : 'w') : p.king ? 'B' : 'b') : '.';
  return key;
}

/** Mitu korda viimane seis ajaloos esineb (sh viimane ise). */
export function repetitionCount(history: readonly Position[]): number {
  const last = history[history.length - 1];
  if (!last) return 0;
  const key = positionKey(last);
  let count = 0;
  for (const p of history) if (positionKey(p) === key) count++;
  return count;
}

/**
 * Mängu tulemus. `history` (seisud algusest kuni praeguseni, viimane = position)
 * on vajalik ainult kolmekordse korduse tuvastamiseks.
 */
export function gameResult(position: Position, history?: readonly Position[]): GameResult {
  if (legalMoves(position).length === 0) {
    return { status: 'win', winner: opponent(position.turn), reason: 'no-moves' };
  }
  if (position.quietKingPlies >= DRAW_QUIET_KING_PLIES) return { status: 'draw', reason: 'king-moves' };
  if ((position.loneKingPlies ?? 0) >= DRAW_LONE_KING_PLIES) return { status: 'draw', reason: 'lone-king' };
  if (history && repetitionCount(history) >= DRAW_REPETITIONS) return { status: 'draw', reason: 'repetition' };
  return { status: 'ongoing' };
}

/** Käigu tekstikuju: "c3-d4" või löömisel "d4:f6:d8". */
export function formatMove(move: Move): string {
  const sep = move.captures.length > 0 ? ':' : '-';
  return [move.from, ...move.path].map(squareName).join(sep);
}

/**
 * Leiab tekstilise käigu seaduslike käikude seast. Löömise vahepealsed ruudud
 * võib ära jätta ("d4:d8"), kui käik on ikkagi üheselt mõistetav.
 */
export function findMove(position: Position, text: string): Move | null {
  const parts = text.trim().toLowerCase().split(/[-:x×]/);
  const squares = parts.map(parseSquare);
  if (squares.length < 2 || squares.some((s) => s === null)) return null;
  const [from, ...rest] = squares as Square[];
  const target = rest[rest.length - 1];
  const candidates = legalMoves(position).filter((m) => {
    if (m.from !== from) return false;
    if (rest.length === 1) return finalSquare(m) === target;
    return m.path.length === rest.length && m.path.every((sq, i) => sq === rest[i]);
  });
  return candidates.length === 1 ? (candidates[0] ?? null) : null;
}
