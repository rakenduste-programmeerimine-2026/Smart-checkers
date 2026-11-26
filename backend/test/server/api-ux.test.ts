import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createEngineOpponent, type Opponent } from '../../src/ai/opponent.js';
import { formatMove, legalMoves } from '../../src/game/rules.js';
import { buildApp } from '../../src/server/app.js';

/** Deterministlik "claude": valib alati esimese seadusliku käigu. */
const firstMove: Opponent = {
  kind: 'claude',
  async chooseMove(pos) {
    const move = legalMoves(pos)[0];
    return move ? { move, notation: formatMove(move), source: 'claude' } : null;
  },
};

let app: FastifyInstance;
const start = () => {
  app = buildApp({ opponents: { engine: createEngineOpponent(() => 0), claude: firstMove } });
  return app;
};
afterEach(async () => app?.close());

const newGame = async (payload: Record<string, unknown> = {}) => {
  const res = await app.inject({ method: 'POST', url: '/api/games', payload });
  return res.json().game as { id: string; ply: number };
};
const post = (url: string, payload: Record<string, unknown> = {}) => app.inject({ method: 'POST', url, payload });

describe('ohutu kordus (expectedPly)', () => {
  it('sama käigu kordus ei tee midagi topelt', async () => {
    start();
    const game = await newGame();
    expect(game.ply).toBe(0);
    const first = await post(`/api/games/${game.id}/moves`, { move: 'c3-d4', expectedPly: 0 });
    expect(first.statusCode).toBe(200);
    expect(first.json().game.ply).toBe(2);
    expect(first.json().game.lastMove).toMatchObject({ from: expect.any(String), path: expect.any(Array) });

    // Sama käik teisel kujul on samuti kordus.
    const retry = await post(`/api/games/${game.id}/moves`, { move: 'c3:d4', expectedPly: 0 });
    expect(retry.json()).toMatchObject({ duplicate: true });
    const retrySame = await post(`/api/games/${game.id}/moves`, { move: 'c3-d4', expectedPly: 0 });
    expect(retrySame.statusCode).toBe(200);
    expect(retrySame.json()).toMatchObject({ duplicate: true, game: { ply: 2 } });
    expect(retrySame.json().aiMove).not.toBeNull();
  });

  it('vananenud seisust tehtud käik saab 409 koos praeguse mänguga', async () => {
    start();
    const game = await newGame();
    await post(`/api/games/${game.id}/moves`, { move: 'c3-d4', expectedPly: 0 });
    const stale = await post(`/api/games/${game.id}/moves`, { move: 'e3-f4', expectedPly: 0 });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ stale: true, game: { ply: 2 } });
    const future = await post(`/api/games/${game.id}/moves`, { move: 'e3-f4', expectedPly: 7 });
    expect(future.statusCode).toBe(409);
  });

  it('tagasivõtt kontrollib samuti seisu', async () => {
    start();
    const game = await newGame();
    await post(`/api/games/${game.id}/moves`, { move: 'c3-d4' });
    expect((await post(`/api/games/${game.id}/undo`, { expectedPly: 1 })).statusCode).toBe(409);
    const ok = await post(`/api/games/${game.id}/undo`, { expectedPly: 2 });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().game).toMatchObject({ ply: 0, canUndo: false });
    // Kordus pärast õnnestunud tagasivõttu ei võta rohkem tagasi.
    expect((await post(`/api/games/${game.id}/undo`, { expectedPly: 2 })).statusCode).toBe(409);
  });
});

describe('alistumine ja viik', () => {
  it('inimene alistub AI-le', async () => {
    start();
    const game = await newGame();
    const res = await post(`/api/games/${game.id}/resign`);
    expect(res.statusCode).toBe(200);
    expect(res.json().game.result).toEqual({ status: 'win', winner: 'black', reason: 'resign' });
    expect((await post(`/api/games/${game.id}/resign`)).statusCode).toBe(409);
    expect((await post(`/api/games/${game.id}/undo`)).statusCode).toBe(409);
    expect((await post(`/api/games/${game.id}/moves`, { move: 'c3-d4' })).statusCode).toBe(409);
  });

  it('AI võtab algseisus viigi vastu', async () => {
    start();
    const game = await newGame();
    const res = await post(`/api/games/${game.id}/draw`);
    expect(res.json()).toMatchObject({ status: 'accepted', game: { result: { status: 'draw', reason: 'agreement' } } });
    expect((await post(`/api/games/${game.id}/draw`)).statusCode).toBe(409);
  });

  it('kahe inimese mängus pakub üks ja teine vastab', async () => {
    start();
    const game = await newGame({ opponent: 'none' });
    const offer = await post(`/api/games/${game.id}/draw`, { color: 'white' });
    expect(offer.json()).toMatchObject({ status: 'pending', game: { drawOffer: 'white' } });
    expect((await post(`/api/games/${game.id}/draw`, { action: 'decline', color: 'white' })).statusCode).toBe(409);
    const declined = await post(`/api/games/${game.id}/draw`, { action: 'decline', color: 'black' });
    expect(declined.json()).toMatchObject({ status: 'declined', game: { drawOffer: null } });
    await post(`/api/games/${game.id}/draw`, { color: 'black' });
    const accepted = await post(`/api/games/${game.id}/draw`, { color: 'white' });
    expect(accepted.json().status).toBe('accepted');
  });

  it('kontrollib sisendit', async () => {
    start();
    const game = await newGame({ opponent: 'none' });
    expect((await post(`/api/games/${game.id}/draw`, { action: 'maybe' })).statusCode).toBe(400);
    expect((await post(`/api/games/${game.id}/resign`, { color: 'red' })).statusCode).toBe(400);
    expect((await post(`/api/games/puudub/resign`)).statusCode).toBe(404);
  });
});

describe('analüüs ja vihje', () => {
  it('annab hinnangu ja parimad käigud', async () => {
    start();
    const game = await newGame({ opponent: 'none' });
    const res = await app.inject({ method: 'GET', url: `/api/games/${game.id}/analysis?top=2&level=beginner` });
    expect(res.statusCode).toBe(200);
    const { analysis } = res.json();
    expect(analysis).toMatchObject({ turn: 'white', depth: 2, summary: expect.any(String) });
    expect(analysis.bestMoves).toHaveLength(2);
    expect(analysis.bestMoves[0]).toMatchObject({ move: expect.any(String), from: expect.any(String), score: expect.any(Number) });
    expect((await app.inject({ method: 'GET', url: `/api/games/${game.id}/analysis?top=99` })).statusCode).toBe(400);
  });

  it('lõppenud mängus vihjet pole', async () => {
    start();
    const game = await newGame();
    const hint = await post(`/api/games/${game.id}/hint`);
    expect(hint.json()).toMatchObject({ hint: expect.any(String), detail: { from: expect.any(String) } });
    await post(`/api/games/${game.id}/resign`);
    expect((await post(`/api/games/${game.id}/hint`)).json()).toEqual({ hint: null, detail: null });
  });
});
