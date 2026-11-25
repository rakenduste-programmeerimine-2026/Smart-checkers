/**
 * PDN (Portable Draughts Notation) eksport ja import.
 *
 * Vene kabe on PDN-is GameType 25. Käigud on kujul "c3-d4" ja löömised "c3:e5:g7".
 */
import type { GameResult } from '../game/types.js';
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

export function toPdn(record: GameRecord): string {
  const headers: Array<[string, string]> = [
    ['Event', record.meta.event ?? 'Smart-checkers'],
    ['Date', pdnDate(record.meta.startedAt)],
    ['White', record.meta.white ?? '?'],
    ['Black', record.meta.black ?? '?'],
    ['Result', resultToken(record.result)],
    ['GameType', RUSSIAN_DRAUGHTS_GAME_TYPE],
  ];
  const tokens: string[] = [];
  record.moves.forEach((move, i) => {
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

/** Loeb ühe mängu PDN-teksti. Kommentaarid ({...}) ja variandid ((...)) jäetakse vahele. */
export function parsePdn(text: string): ParsedPdn {
  const headers: Record<string, string> = {};
  const headerRe = /\[(\w+)\s+"((?:[^"\\]|\\.)*)"\]/g;
  let m: RegExpExecArray | null;
  while ((m = headerRe.exec(text)) !== null) {
    if (m[1] && m[2] !== undefined) headers[m[1]] = m[2].replace(/\\(.)/g, '$1');
  }

  let body = text.replace(headerRe, ' ').replace(/\{[^}]*\}/g, ' ');
  // Pesastatud variandid eemaldatakse seestpoolt väljapoole.
  while (/\([^()]*\)/.test(body)) body = body.replace(/\([^()]*\)/g, ' ');

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
  const game = new Game(id ? { id, meta } : { meta });
  for (const move of parsed.moves) game.play(move, startedAt ? new Date(startedAt) : undefined);
  return game;
}
