import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createEngineOpponent, type Opponent } from '../../src/ai/opponent.js';
import { applyMove, findMove, formatMove, initialPosition, legalMoves } from '../../src/game/rules.js';

const afterC3D4 = applyMove(initialPosition(), findMove(initialPosition(), 'c3-d4')!);
const firstReply = legalMoves(afterC3D4)[0]!;
const FIRST_REPLY = formatMove(firstReply);
import { buildApp } from '../../src/server/app.js';

/** Deterministlik "claude": valib alati esimese seadusliku käigu. */
const firstMove: Opponent = {
  kind: 'claude',
  async chooseMove(pos) {
    const move = legalMoves(pos)[0];
    return move ? { move, notation: formatMove(move), source: 'claude', reason: 'test' } : null;
  },
};

let app: FastifyInstance;
const start = () => {
  app = buildApp({ opponents: { engine: createEngineOpponent(() => 0), claude: firstMove } });
  return app;
};
afterEach(async () => app?.close());

describe('REST API', () => {
  it('GET /health', async () => {
    const res = await start().inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('loob mängu AI vastu ja AI vastab inimese käigule', async () => {
    start();
    const created = await app.inject({ method: 'POST', url: '/api/games', payload: {} });
    expect(created.statusCode).toBe(201);
    const { game } = created.json();
    expect(game).toMatchObject({ opponent: 'claude', level: 'medium', humanColor: 'white', turn: 'white' });
    expect(game.pieces).toHaveLength(24);
    expect(game.legalMoves).toHaveLength(7);

    const moved = await app.inject({ method: 'POST', url: `/api/games/${game.id}/moves`, payload: { move: 'c3-d4' } });
    expect(moved.statusCode).toBe(200);
    const body = moved.json();
    expect(body.aiMove).toMatchObject({ move: FIRST_REPLY, source: 'claude', reason: 'test', captures: [] });
    expect(body.game.history).toEqual(['c3-d4', FIRST_REPLY]);
    expect(body.game.turn).toBe('white');
  });

  it('AI alustab, kui inimene mängib mustadega', async () => {
    const res = await start().inject({ method: 'POST', url: '/api/games', payload: { humanColor: 'black', opponent: 'engine' } });
    const body = res.json();
    expect(body.aiMove.source).toBe('engine');
    expect(body.game.turn).toBe('black');
    expect(body.game.history).toHaveLength(1);
  });

  it('kahe mängija mängus AI ei käi', async () => {
    start();
    const { game } = (await app.inject({ method: 'POST', url: '/api/games', payload: { opponent: 'none' } })).json();
    const res = await app.inject({ method: 'POST', url: `/api/games/${game.id}/moves`, payload: { move: 'c3-d4' } });
    expect(res.json().aiMove).toBeNull();
    expect(res.json().game.turn).toBe('black');
  });

  it('lükkab tagasi ebaseadusliku käigu, vigase sisendi ja tundmatu mängu', async () => {
    start();
    const { game } = (await app.inject({ method: 'POST', url: '/api/games', payload: {} })).json();
    const illegal = await app.inject({ method: 'POST', url: `/api/games/${game.id}/moves`, payload: { move: 'c3-c4' } });
    expect(illegal.statusCode).toBe(422);
    expect(illegal.json().error).toMatch(/pole seaduslik/);
    const bad = await app.inject({ method: 'POST', url: '/api/games', payload: { level: 'jumal' } });
    expect(bad.statusCode).toBe(400);
    const missing = await app.inject({ method: 'GET', url: '/api/games/olematu' });
    expect(missing.statusCode).toBe(404);
  });

  it('annab vihje', async () => {
    start();
    const { game } = (await app.inject({ method: 'POST', url: '/api/games', payload: {} })).json();
    const res = await app.inject({ method: 'POST', url: `/api/games/${game.id}/hint` });
    expect(game.legalMoves).toContain(res.json().hint);
  });

  it('POST /api/ai/move annab olekuta vastukäigu', async () => {
    start();
    const res = await app.inject({ method: 'POST', url: '/api/ai/move', payload: { moves: ['c3-d4'], opponent: 'claude' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().position.turn).toBe('black');
    expect(res.json().aiMove.move).toBe(FIRST_REPLY);
    const bad = await app.inject({ method: 'POST', url: '/api/ai/move', payload: { moves: ['c3-d4', 'c3-d4'] } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toMatch(/Käik 2/);
  });
});
