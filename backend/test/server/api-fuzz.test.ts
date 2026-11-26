/**
 * Juhuslikud API-toimingud (käik, vale käik, tagasivõtt, alistumine, viik,
 * vihje, analüüs, eksport/import) mitmes mängus. Kontrollitakse, et server ei
 * anna kunagi 5xx viga ja et mängu olek on alati järjepidev.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createEngineOpponent, type Opponent } from '../../src/ai/opponent.js';
import { formatMove, legalMoves } from '../../src/game/rules.js';
import { PlayerStore } from '../../src/players/store.js';
import { buildApp } from '../../src/server/app.js';

/** Väike deterministlik juhuarvugeneraator (mulberry32). */
const rng = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const engine = createEngineOpponent(() => 0);
const firstMove: Opponent = {
  kind: 'claude',
  async chooseMove(pos) {
    const move = legalMoves(pos)[0];
    return move ? { move, notation: formatMove(move), source: 'claude' } : null;
  },
};

interface GameView {
  id: string;
  ply: number;
  history: string[];
  canUndo: boolean;
  drawOffer: string | null;
  opponent: string;
  result: { status: string; reason?: string };
  legalMoves: string[];
}

let app: FastifyInstance;
afterEach(async () => app?.close());

describe('API juhuslike toimingutega', () => {
  it('ei anna kunagi 5xx viga ja olek jääb järjepidevaks', { timeout: 120_000 }, async () => {
    const players = new PlayerStore();
    app = buildApp({ opponents: { engine, claude: firstMove }, players,
      security: { rateLimit: { max: 1_000_000, aiMax: 1_000_000, boardMax: 1_000_000 } },
    });
    const ids: string[] = [];
    for (const name of ['Mari', 'Jüri']) {
      ids.push((await app.inject({ method: 'POST', url: '/api/players', payload: { name } })).json().player.id);
    }

    for (let seed = 1; seed <= 12; seed++) {
      const random = rng(seed);
      const pick = <T>(xs: readonly T[]): T => xs[Math.floor(random() * xs.length)]!;
      const opponent = pick(['none', 'engine', 'claude'] as const);
      const payload: Record<string, unknown> = { opponent, level: 'beginner' };
      if (opponent === 'none' && random() < 0.5) payload.players = { white: ids[0], black: ids[1] };
      const created = await app.inject({ method: 'POST', url: '/api/games', payload });
      expect(created.statusCode).toBe(201);
      let game = created.json().game as GameView;

      for (let step = 0; step < 40; step++) {
        const action = pick(['move', 'move', 'move', 'move', 'stale', 'bad', 'undo', 'resign', 'draw', 'hint', 'analysis', 'get']);
        const url = `/api/games/${game.id}`;
        const before = game;
        const res =
          action === 'move' && game.legalMoves.length > 0
            ? await app.inject({ method: 'POST', url: `${url}/moves`, payload: { move: pick(game.legalMoves), expectedPly: game.ply } })
            : action === 'stale'
              ? await app.inject({ method: 'POST', url: `${url}/moves`, payload: { move: 'c3-d4', expectedPly: game.ply + 1 } })
              : action === 'bad'
                ? await app.inject({ method: 'POST', url: `${url}/moves`, payload: { move: pick(['', 'zz', 'a1-a2', 'c3-c4', 'x'.repeat(50)]) } })
                : action === 'undo'
                  ? await app.inject({ method: 'POST', url: `${url}/undo`, payload: { expectedPly: game.ply } })
                  : action === 'resign' && random() < 0.3
                    ? await app.inject({ method: 'POST', url: `${url}/resign`, payload: { color: pick(['white', 'black']) } })
                    : action === 'draw'
                      ? await app.inject({ method: 'POST', url: `${url}/draw`, payload: { action: pick(['offer', 'decline']), color: pick(['white', 'black']) } })
                      : action === 'hint'
                        ? await app.inject({ method: 'POST', url: `${url}/hint`, payload: {} })
                        : action === 'analysis'
                          ? await app.inject({ method: 'GET', url: `${url}/analysis` })
                          : await app.inject({ method: 'GET', url });

        expect(res.statusCode, `${action} ${res.body}`).toBeLessThan(500);
        if (action === 'undo') {
          // canUndo ennustab täpselt, kas tagasivõtt õnnestub.
          expect(res.statusCode === 200, `canUndo=${before.canUndo} ${res.body}`).toBe(before.canUndo);
        }
        if (action === 'stale') expect(res.statusCode).toBe(409);
        if (action === 'bad') expect([400, 409, 422]).toContain(res.statusCode);

        const body = res.json() as { game?: GameView };
        if (body.game) game = body.game;
        else game = (await app.inject({ method: 'GET', url })).json().game;

        expect(game.ply).toBe(game.history.length);
        if (game.result.status !== 'ongoing') {
          expect(game.legalMoves).toEqual([]);
          // Alistumist ja kokkulepitud viiki ei saa tagasi võtta (tavalise lõpu saab).
          if (['resign', 'agreement'].includes(game.result.reason ?? '')) expect(game.canUndo).toBe(false);
        }
        if (game.drawOffer) expect(game.opponent).toBe('none');
      }

      // Iga mäng peab olema eksporditav ja tagasi imporditav.
      const pdn = await app.inject({ method: 'GET', url: `/api/games/${game.id}/pdn` });
      expect(pdn.statusCode).toBe(200);
      const imported = await app.inject({ method: 'POST', url: '/api/games/import', payload: { pdn: pdn.body } });
      expect(imported.statusCode, imported.body).toBe(201);
      expect(imported.json().game.history).toEqual(game.history);
    }

    // Edetabel on pärast kõike endiselt kehtiv.
    const board = await app.inject({ method: 'GET', url: '/api/players' });
    expect(board.statusCode).toBe(200);
  });
});
