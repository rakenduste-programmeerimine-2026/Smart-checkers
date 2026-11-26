/**
 * AI vastane, kes valib käigu välise AI API (Claude) kaudu.
 *
 * Mudelile antakse laua seis ja nummerdatud seaduslike käikude nimekiri. Mudel
 * vastab struktureeritud JSON-iga ({ moveIndex, reason }), nii et ebaseaduslikku
 * käiku ta valida ei saa. Kui API ei vasta, keeldub või tagastab vigase vastuse,
 * teeb käigu kohalik mootor, et mäng ei jääks seisma.
 */
import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod/v4';
import { formatMove, legalMoves } from '../game/rules.js';
import { toSquare } from '../game/squares.js';
import type { Move, Position } from '../game/types.js';
import { rankMoves, type AiLevel } from './engine.js';
import { createEngineOpponent, type Opponent, type OpponentMove } from './opponent.js';

export const DEFAULT_CLAUDE_MODEL = 'claude-opus-5-5';

const MoveChoice = z.object({
  moveIndex: z.number().int().describe('Valitud käigu number nimekirjast'),
  reason: z.string().describe('Üks lühike lause eesti keeles, miks see käik'),
});

const SYSTEM_PROMPT = [
  'Sa oled kabe (vene kabe) mängija nutikal füüsilisel kabelaual.',
  'Reeglid: löömine on kohustuslik, lihtnupp lööb ka tagasi, tamm liigub ja lööb kaugelt,',
  'löömisvariandi võib valida vabalt. Seaduslikud käigud on sulle juba arvutatud.',
  'Vali nimekirjast üks käik ja vasta ainult nõutud JSON-kujul.',
].join(' ');

/** Tase mõjutab, kui palju mudel mõtleb ja kas talle antakse mootori hinnangud vihjeks. */
const LEVEL_SETTINGS: Record<AiLevel, { effort: 'low' | 'medium' | 'high'; style: string; engineHints: boolean }> = {
  beginner: {
    effort: 'low',
    style: 'Mängi nagu algaja: vali mõistlik, aga mitte alati parim käik. Ära anna nuppe meelega ära.',
    engineHints: false,
  },
  medium: { effort: 'low', style: 'Mängi hästi ja vali tugev käik.', engineHints: false },
  strong: {
    effort: 'medium',
    style: 'Mängi nii tugevalt kui suudad. Arvesta mootori hinnanguid, aga otsusta ise.',
    engineHints: true,
  },
};

/** Laua seis tekstina, valge all (rida 1) ja must üleval (rida 8). */
export function renderBoard(position: Position): string {
  const symbol = (f: number, r: number): string => {
    const sq = toSquare(f, r);
    if (sq === null) return ' ';
    const piece = position.board[sq];
    if (!piece) return '.';
    const ch = piece.color === 'white' ? 'w' : 'b';
    return piece.king ? ch.toUpperCase() : ch;
  };
  const rows: string[] = [];
  for (let r = 7; r >= 0; r--) {
    const cells: string[] = [];
    for (let f = 0; f < 8; f++) cells.push(symbol(f, r));
    rows.push(`${r + 1} ${cells.join(' ')}`);
  }
  rows.push('  a b c d e f g h');
  return rows.join('\n');
}

export function buildPrompt(position: Position, moves: Move[], level: AiLevel): string {
  const settings = LEVEL_SETTINGS[level];
  const color = position.turn === 'white' ? 'valged (w/W)' : 'mustad (b/B)';
  let list = moves.map((m, i) => `${i}: ${formatMove(m)}`).join('\n');
  if (settings.engineHints) {
    const scores = new Map(rankMoves(position, 'medium').map((c) => [formatMove(c.move), c.score]));
    list = moves.map((m, i) => `${i}: ${formatMove(m)} (mootori hinnang ${scores.get(formatMove(m)) ?? '?'})`).join('\n');
  }
  return [
    `Sina mängid: ${color}. Suurtäht tähendab tammi, "." on tühi tume ruut.`,
    '',
    renderBoard(position),
    '',
    'Seaduslikud käigud:',
    list,
    '',
    settings.style,
  ].join('\n');
}

export interface ClaudeOpponentOptions {
  /** Anthropic klient. Vaikimisi loetakse võti keskkonnast (ANTHROPIC_API_KEY). */
  client?: Anthropic;
  model?: string;
  /** Kes teeb käigu, kui API ei vasta. Vaikimisi kohalik mootor. */
  fallback?: Opponent;
  /** Ühe päringu ajapiirang millisekundites. */
  timeoutMs?: number;
  /** Mitu Claude päringut võib korraga käia; ülejäänud käigud teeb kohalik mootor. */
  maxConcurrent?: number;
  onError?: (error: unknown) => void;
}

export function createClaudeOpponent(options: ClaudeOpponentOptions = {}): Opponent {
  const model = options.model ?? DEFAULT_CLAUDE_MODEL;
  const fallback = options.fallback ?? createEngineOpponent();
  const timeoutMs = options.timeoutMs ?? 30_000;
  const maxConcurrent = options.maxConcurrent ?? 4;
  let active = 0;
  let client = options.client;

  const useFallback = async (position: Position, level: AiLevel, reason: string): Promise<OpponentMove | null> => {
    const result = await fallback.chooseMove(position, level);
    return result ? { ...result, fallbackReason: reason } : null;
  };

  return {
    kind: 'claude',
    async chooseMove(position, level) {
      const moves = legalMoves(position);
      if (moves.length === 0) return null;
      const only = moves[0];
      if (moves.length === 1 && only) {
        // Ainus käik: API-d pole vaja küsida.
        return { move: only, notation: formatMove(only), source: 'claude', reason: 'Ainus seaduslik käik.' };
      }

      if (active >= maxConcurrent) return useFallback(position, level, 'AI on hõivatud');
      active++;
      try {
        client ??= new Anthropic();
        const response = await client.beta.messages.parse(
          {
            model,
            max_tokens: 4000,
            // Turvaklassifikaatori keeldumisel jätkab API ise varumudeliga.
            betas: ['server-side-fallback-2026-07-01'],
            fallbacks: 'default',
            system: SYSTEM_PROMPT,
            output_config: { effort: LEVEL_SETTINGS[level].effort, format: betaZodOutputFormat(MoveChoice) },
            messages: [{ role: 'user', content: buildPrompt(position, moves, level) }],
          },
          { timeout: timeoutMs },
        );
        if (response.stop_reason === 'refusal') return useFallback(position, level, 'AI keeldus vastamast');
        const choice = response.parsed_output;
        if (!choice) return useFallback(position, level, 'AI vastus polnud loetav');
        const move = moves[choice.moveIndex];
        if (!move) return useFallback(position, level, `AI valis olematu käigu ${choice.moveIndex}`);
        return { move, notation: formatMove(move), source: 'claude', reason: choice.reason };
      } catch (error) {
        options.onError?.(error);
        if (error instanceof Anthropic.AuthenticationError) return useFallback(position, level, 'AI API võti puudub või on vale');
        if (error instanceof Anthropic.RateLimitError) return useFallback(position, level, 'AI API päringulimiit täis');
        if (error instanceof Anthropic.APIConnectionTimeoutError) return useFallback(position, level, 'AI API ei vastanud õigel ajal');
        if (error instanceof Anthropic.APIError) return useFallback(position, level, `AI API viga ${error.status ?? ''}`.trim());
        return useFallback(position, level, 'AI API pole kättesaadav');
      } finally {
        active--;
      }
    },
  };
}
