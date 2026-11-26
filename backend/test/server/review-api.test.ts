import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createEngineOpponent } from '../../src/ai/opponent.js';
import { rankMoves } from '../../src/ai/engine.js';
import { BoardController } from '../../src/board/controller.js';
import { buildApp } from '../../src/server/app.js';
import { GameStore, type Game } from '../../src/server/games.js';

const engine = createEngineOpponent(() => 0);
let app: FastifyInstance | undefined;
afterEach(async () => app?.close());

/** Kahe mängija mäng, kus valge valib igal käigul halvima ja must parima. */
const badGame = (store: GameStore, plies = 8): Game => {
  const game = store.create({ opponent: null, level: 'medium', humanColor: 'white' });
  for (let i = 0; i < plies; i++) {
    const ranked = rankMoves(game.position, 'beginner', { timeMs: 10_000 });
    const move = game.position.turn === 'white' ? ranked[ranked.length - 1]! : ranked[0]!;
    store.play(game, move.move);
  }
  return game;
};

describe('mänguülevaade', () => {
  it('GET /api/games/:id/review annab iga käigu hinnangu', async () => {
    app = buildApp({ opponents: { engine, claude: engine } });
    const created = await app.inject({ method: 'POST', url: '/api/games', payload: { opponent: 'none' } });
    const id = created.json().game.id;
    await app.inject({ method: 'POST', url: `/api/games/${id}/moves`, payload: { move: 'c3-d4' } });
    const res = await app.inject({ method: 'GET', url: `/api/games/${id}/review` });
    expect(res.statusCode).toBe(200);
    const { review } = res.json();
    expect(review.moves).toHaveLength(1);
    expect(review.moves[0]).toMatchObject({ ply: 0, color: 'white', move: 'c3-d4', classification: expect.any(String) });
    expect(review.summary.white.accuracy).toBeGreaterThanOrEqual(0);
    expect((await app.inject({ method: 'GET', url: '/api/games/puudub/review' })).statusCode).toBe(404);
  });

  it('jätab tulemuse meelde, kuni mäng muutub', async () => {
    const store = new GameStore({ engine, claude: engine });
    const game = badGame(store, 2);
    const first = store.review(game, 50);
    expect(store.review(game, 50)).toBe(first);
    expect(store.cachedReview(game)).toBeNull();
    await first;
    expect(store.cachedReview(game)).toBe(await first);
    store.undo(game);
    expect(store.cachedReview(game)).toBeNull();
    expect(store.review(game, 50)).not.toBe(first);
    await store.delete(game.id);
  });

  it('laua kordus näitab viga ja paremat käiku', async () => {
    let t = 0;
    const store = new GameStore({ engine, claude: engine }, undefined, { now: () => new Date(t) });
    const game = badGame(store);
    const review = await store.review(game, 200);
    const ply = review.moves.findIndex((m) => m.classification === 'mistake' || m.classification === 'blunder');
    expect(ply).toBeGreaterThanOrEqual(0);
    const board = new BoardController('laud1', store, { now: () => t });
    board.startReplay(game);
    for (let i = 0; i < ply; i++) board.update({ buttons: [2] });
    const shown = board.update({});
    expect(shown.lcd[1]).toMatch(/^(Suur viga|Viga)! /);
    expect(shown.lcd[1]).toContain(review.moves[ply]!.best);
    expect(shown.leds.some((l) => l.color === '00E0FF')).toBe(true);
    // Hea käik kuvatakse tavaliselt.
    const good = review.moves.findIndex((m) => m.classification === 'best' || m.classification === 'forced');
    board.startReplay(game);
    for (let i = 0; i < good; i++) board.update({ buttons: [2] });
    expect(board.update({}).lcd[0]).toMatch(/^Kordus /);
  });
});
