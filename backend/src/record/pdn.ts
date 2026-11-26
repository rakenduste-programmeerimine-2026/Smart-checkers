/**
 * PDN (Portable Draughts Notation) eksport ja import.
 *
 * Vene kabe on PDN-is GameType 25. Käigud on kujul "c3-d4" ja löömised "c3:e5:g7".
 */
import { parsePositionKey } from '../game/rules.js';
import { parseSquare, squareName, SQUARE_COUNT } from '../game/squares.js';
import type { GameResult, Position } from '../game/types.js';
import { Game, type GameRecord } from './game.js';

export const RUSSIAN_DRAUGHTS_GAME_TYPE = '25';

const RESULT_TOKENS = ['1-0', '0-1', '1/2-1/2', '2-0', '0-2', '1-1', '*'] as const;

export function resultToken(result: GameResult): string {
  if (result.status === 'win') return result.winner === 'white' ? '1-0' : '0-1';
  if (result.status === 'draw') return '1/2-1/2';
  return '*';
}

const escape = (value: string): string => value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

/** PDN kuupäev kujul YYYY.MM.DD. */
const pdnDate = (iso: string): string => iso.slice(0, 10).replace(/-/g, '.');

/** PDN FEN, näiteks "W:Wc3,Ka1:Bh8" (K = tamm). */
export function toFen(position: Position): string {
  const side = (color: 'white' | 'black') =>
    position.board.flatMap((p, sq) => (p?.color === color ? [`${p.king ? 'K' : ''}${squareName(sq)}`] : [])).join(',');
  return `${position.turn === 'white' ? 'W' : 'B'}:W${side('white')}:B${side('black')}`;
}

/**
 * Loeb PDN FEN-i ("W:Wc3,Ka1:Bh8"). Toetatud on tähtruudud; numbrilised ruudud
 * (rahvusvahelise kabe kujul) annavad vea.
 */
export function parseFen(fen: string): Position {
  const parts = fen.trim().replace(/\.$/, '').split(':');
  const turn = parts[0]?.toUpperCase();
  if (turn !== 'W' && turn !== 'B') throw new Error('FEN peab algama W või B');
  const board: Position['board'][number][] = Array.from({ length: SQUARE_COUNT }, () => null);
  for (const part of parts.slice(1)) {
    const color = part[0]?.toUpperCase() === 'W' ? 'white' : part[0]?.toUpperCase() === 'B' ? 'black' : null;
    if (!color) throw new Error(`Vigane FEN osa: ${part}`);
    for (const item of part.slice(1).split(',').filter(Boolean)) {
      const king = /^k/i.test(item);
      const sq = parseSquare(item.replace(/^k/i, '').toLowerCase());
      if (sq === null) throw new Error(`Vigane FEN ruut: ${item}`);
      if (board[sq]) throw new Error(`FEN-is on ruut ${item} kaks korda`);
      board[sq] = { color, king };
    }
  }
  return { board, turn: turn === 'W' ? 'white' : 'black', quietKingPlies: 0 };
}

export function toPdn(record: GameRecord): string {
  const start = record.start ? parsePositionKey(record.start) : null;
  const headers: Array<[string, string]> = [
    ['Event', record.meta.event ?? 'Smart-checkers'],
    ['Date', pdnDate(record.meta.startedAt)],
    ['White', record.meta.white ?? '?'],
    ['Black', record.meta.black ?? '?'],
    ['Result', resultToken(record.result)],
    ['GameType', RUSSIAN_DRAUGHTS_GAME_TYPE],
  ];
  if (start) headers.push(['SetUp', '1'], ['FEN', toFen(start)]);
  const tokens: string[] = [];
  // Kui algseisus on must käigul, algab numeratsioon "1...".
  const offset = start?.turn === 'black' ? 1 : 0;
  if (offset && record.moves.length > 0) tokens.push('1...');
  record.moves.forEach((move, j) => {
    const i = j + offset;
    if (i % 2 === 0) tokens.push(`${i / 2 + 1}.`);
    tokens.push(move.text);
  });
  tokens.push(resultToken(record.result));

  // Ridade pikkus kuni 80 märki, nagu PGN/PDN-is tavaks.
  const lines: string[] = [];
  let line = '';
  for (const token of tokens) {
    if (line && line.length + 1 + token.length > 80) {
      lines.push(line);
      line = token;
    } else {
      line = line ? `${line} ${token}` : token;
    }
  }
  if (line) lines.push(line);

  return `${headers.map(([k, v]) => `[${k} "${escape(v)}"]`).join('\n')}\n\n${lines.join('\n')}\n`;
}

export interface ParsedPdn {
  headers: Record<string, string>;
  moves: string[];
  result: string;
}

/**
 * Eemaldab kommentaarid ({...}) ja (pesastatud) variandid ((...)) ühe läbimisega.
 * Regulaaravaldistega korduv eemaldamine oleks sügavalt pesastatud sisendil ruutkeerukusega
 * ja võiks serveri pikaks ajaks kinni panna.
 */
function stripCommentsAndVariations(text: string): string {
  const out: string[] = [];
  let depth = 0;
  let inComment = false;
  for (const ch of text) {
    if (inComment) {
      if (ch === '}') inComment = false;
      continue;
    }
    if (ch === '{') {
      inComment = true;
      out.push(' ');
    } else if (ch === '(') {
      depth++;
      out.push(' ');
    } else if (ch === ')') {
      if (depth === 0) throw new Error('Liigne ")"');
      depth--;
    } else if (depth === 0) {
      out.push(ch);
    }
  }
  if (inComment) throw new Error('Lõpetamata kommentaar');
  if (depth > 0) throw new Error('Lõpetamata variant');
  return out.join('');
}

/** Loeb ühe mängu PDN-teksti. Kommentaarid ({...}) ja variandid ((...)) jäetakse vahele. */
export function parsePdn(text: string): ParsedPdn {
  const headers: Record<string, string> = {};
  const headerRe = /\[(\w+)\s+"((?:[^"\\]|\\.)*)"\]/g;
  let m: RegExpExecArray | null;
  while ((m = headerRe.exec(text)) !== null) {
    if (m[1] && m[2] !== undefined) headers[m[1]] = m[2].replace(/\\(.)/g, '$1');
  }

  const body = stripCommentsAndVariations(text.replace(headerRe, ' '));

  const moves: string[] = [];
  let result = '*';
  for (const raw of body.split(/\s+/)) {
    const token = raw.replace(/^\d+\.+/, '');
    if (!token) continue;
    if ((RESULT_TOKENS as readonly string[]).includes(token)) {
      result = token;
      continue;
    }
    if (/^[a-h][1-8]([-:x][a-h][1-8])+[!?]*$/i.test(token)) moves.push(token.replace(/[!?]+$/, '').toLowerCase());
    else throw new Error(`Tundmatu PDN märk: ${raw}`);
  }
  return { headers, moves, result };
}

/** Taastab mängu PDN-tekstist. Viskab vea, kui mõni käik pole seaduslik. */
export function gameFromPdn(text: string, id?: string): Game {
  const parsed = parsePdn(text);
  const date = parsed.headers.Date?.replace(/\./g, '-');
  const startedAt = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? `${date}T00:00:00.000Z` : undefined;
  const name = (v: string | undefined): string | undefined => (v && v !== '?' ? v : undefined);
  const meta: Record<string, string> = {};
  const white = name(parsed.headers.White);
  const black = name(parsed.headers.Black);
  if (white) meta.white = white;
  if (black) meta.black = black;
  if (parsed.headers.Event) meta.event = parsed.headers.Event;
  if (startedAt) meta.startedAt = startedAt;
  const start = parsed.headers.FEN ? parseFen(parsed.headers.FEN) : undefined;
  const game = new Game({ ...(id ? { id } : {}), meta, ...(start ? { start } : {}) });
  for (const move of parsed.moves) game.play(move, startedAt ? new Date(startedAt) : undefined);
  return game;
}
