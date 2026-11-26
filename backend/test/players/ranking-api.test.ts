import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createEngineOpponent, type Opponent } from '../../src/ai/opponent.js';
import { BoardController } from '../../src/board/controller.js';
import { findMove, formatMove, legalMoves } from '../../src/game/rules.js';
import { AI_RATINGS, START_RATING, newRating } from '../../src/players/elo.js';
import { ratedResults } from '../../src/players/rating.js';
import { PlayerStore } from '../../src/players/store.js';
import { buildApp } from '../../src/server/app.js';
import { GameStore } from '../../src/server/games.js';

const firstMove: Opponent = {
  kind: 'claude',
  async chooseMove(pos) {
    const move = legalMoves(pos)[0];
    return move ? { move, notation: formatMove(move), source: 'claude' } : null;
  },
};
const engine = createEngineOpponent(() => 0);

let app: FastifyInstance;
let players: PlayerStore;
const start = () => {
  players = new PlayerStore();
  app = buildApp({ opponents: { engine, claude: firstMove }, players });
  return app;
};
afterEach(async () => app?.close());

const createPlayer = async (name: string) => {
  const res = await app.inject({ method: 'POST', url: '/api/players', payload: { name } });
  expect(res.statusCode).toBe(201);
  return res.json().player as { id: string; rating: number; rank: number };
};
const flush = () => new Promise((r) => setImmediate(r));

describe('mängijate API', () => {
  it('loob, näitab, nimetab ümber ja kustutab mängija', async () => {
    start();
    const p = await createPlayer('Maik');
    expect(p).toMatchObject({ rating: START_RATING, rank: 1, title: 'Harrastaja' });
    expect((await app.inject({ method: 'POST', url: '/api/players', payload: { name: 'maik' } })).statusCode).toBe(409);
    expect((await app.inject({ method: 'POST', url: '/api/players', payload: { name: '' } })).statusCode).toBe(400);
    const got = await app.inject({ method: 'GET', url: `/api/players/${p.id}` });
    expect(got.json().player).toMatchObject({ name: 'Maik', history: [] });
    const renamed = await app.inject({ method: 'PATCH', url: `/api/players/${p.id}`, payload: { name: 'Maik H' } });
    expect(renamed.json().player.name).toBe('Maik H');
    expect((await app.inject({ method: 'PATCH', url: '/api/players/x', payload: { name: 'Q' } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: `/api/players/${p.id}` })).statusCode).toBe(204);
    expect((await app.inject({ method: 'DELETE', url: `/api/players/${p.id}` })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/api/players/${p.id}` })).statusCode).toBe(404);
  });

  it('mäng arvuti vastu uuendab reitingut ja edetabelit', async () => {
    start();
    const p = await createPlayer('Mari');
    const created = await app.inject({
      method: 'POST',
      url: '/api/games',
      payload: { opponent: 'engine', level: 'strong', players: { white: p.id, black: 'ignoreeritakse' } },
    });
    expect(created.statusCode).toBe(201);
    const game = created.json().game;
    expect(game.players).toEqual({ white: { id: p.id, name: 'Mari', rating: START_RATING }, black: null });
    await app.inject({ method: 'POST', url: `/api/games/${game.id}/resign` });
    await flush();
    const board = (await app.inject({ method: 'GET', url: '/api/players' })).json().players;
    expect(board[0]).toMatchObject({
      name: 'Mari',
      rating: newRating(START_RATING, AI_RATINGS.engine.strong, 0, 0),
      stats: { games: 1, losses: 1, byOpponent: { 'engine:strong': { losses: 1 } } },
    });
    // Lõppenud ja edetabelisse kantud mängu ei saa tagasi võtta.
    expect((await app.inject({ method: 'POST', url: `/api/games/${game.id}/undo` })).statusCode).toBe(409);
  });

  it('kahe mängija viik uuendab mõlemat', async () => {
    start();
    const a = await createPlayer('Anna');
    const b = await createPlayer('Bert');
    await players.record([{ playerId: a.id, opponentRating: 1200, opponentKey: 'human', outcome: 'win', gameId: 'x', at: 'x' }]);
    const created = await app.inject({
      method: 'POST',
      url: '/api/games',
      payload: { opponent: 'none', players: { white: a.id, black: b.id } },
    });
    const id = created.json().game.id;
    await app.inject({ method: 'POST', url: `/api/games/${id}/draw`, payload: { color: 'white' } });
    await app.inject({ method: 'POST', url: `/api/games/${id}/draw`, payload: { color: 'black' } });
    await flush();
    const anna = (await players.get(a.id))!;
    const bert = (await players.get(b.id))!;
    expect(anna.rating).toBeLessThan(1220);
    expect(bert.rating).toBeGreaterThan(START_RATING);
    expect(bert.stats.byOpponent.human).toEqual({ wins: 0, losses: 0, draws: 1 });
  });

  it('kontrollib mängijaid mängu loomisel', async () => {
    start();
    const a = await createPlayer('Anna');
    const bad = await app.inject({ method: 'POST', url: '/api/games', payload: { opponent: 'none', players: { white: 'puudub' } } });
    expect(bad.statusCode).toBe(404);
    const same = await app.inject({ method: 'POST', url: '/api/games', payload: { opponent: 'none', players: { white: a.id, black: a.id } } });
    expect(same.statusCode).toBe(400);
  });
});

describe('ratedResults', () => {
  it('ei arvesta ilma mängijateta, pooleli mängu ega ühe mängijaga kahe inimese mängu', async () => {
    const ps = new PlayerStore();
    const a = await ps.create('Anna');
    const store = new GameStore({ engine, claude: engine });
    const ai = store.create({ opponent: 'engine', level: 'medium', humanColor: 'white' });
    expect(ratedResults(ai, { status: 'draw', reason: 'agreement' }, ps, 'x')).toEqual([]);
    expect(ratedResults(ai, { status: 'ongoing' }, ps, 'x')).toEqual([]);
    const half = store.create({ opponent: null, level: 'medium', humanColor: 'white', players: { white: a.id } });
    expect(ratedResults(half, { status: 'win', winner: 'white', reason: 'no-moves' }, ps, 'x')).toEqual([]);
  });

  it('lõppenud mäng kantakse edetabelisse üks kord, ka pärast taastamist', async () => {
    const calls: string[] = [];
    const store = new GameStore({ engine, claude: engine }, undefined, { onGameOver: (g) => void calls.push(g.id) });
    const game = store.create({ opponent: 'engine', level: 'medium', humanColor: 'white', players: { white: 'p1' } });
    store.resign(game, 'white');
    store.result(game);
    expect(calls).toEqual([game.id]);
    const record = store.toRecord(game);
    expect(record).toMatchObject({ rated: true, settings: { players: { white: 'p1', black: null } } });
    const again = new GameStore({ engine, claude: engine }, undefined, { onGameOver: (g) => void calls.push(`x${g.id}`) });
    const restored = again.restore(record);
    expect(restored.rated).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('edetabeli vea korral mäng ei katke', async () => {
    const errors: unknown[] = [];
    const store = new GameStore({ engine, claude: engine }, (e) => errors.push(e), {
      onGameOver: () => {
        throw new Error('katki');
      },
    });
    const game = store.create({ opponent: null, level: 'medium', humanColor: 'white', players: { white: 'p' } });
    store.resign(game, 'black');
    const async = new GameStore({ engine, claude: engine }, (e) => errors.push(e), {
      onGameOver: async () => {
        throw new Error('asünkroonne');
      },
    });
    async.resign(async.create({ opponent: null, level: 'medium', humanColor: 'white', players: { black: 'p' } }), 'white');
    await flush();
    expect(errors).toHaveLength(2);
    // Ilma mängijateta mängu saab pärast lõppu tagasi võtta.
    const casual = store.create({ opponent: null, level: 'medium', humanColor: 'white' });
    store.play(casual, findMove(casual.position, 'c3-d4')!);
    expect(casual.rated).toBe(false);
  });
});

describe('laua menüü mängija valik', () => {
  it('valib mängija ja uus mäng seob ta õige värviga', async () => {
    const ps = new PlayerStore();
    const a = await ps.create('Anna');
    const store = new GameStore({ engine, claude: engine });
    const board = new BoardController('laud1', store, { now: () => 0, players: () => ps.current() });
    board.update({ buttons: [3] });
    for (let i = 0; i < 4; i++) board.update({ buttons: [1] });
    expect(board.update({}).lcd[0]).toBe('>Mangija:kulalin');
    expect(board.update({ buttons: [2] }).lcd[0]).toBe('>Mangija:Anna   ');
    expect(board.update({ buttons: [2] }).lcd[0]).toBe('>Mangija:kulalin');
    board.update({ buttons: [2] });
    board.update({ buttons: [3] });
    const ai = board.newGame({ opponent: 'engine', humanColor: 'black' });
    expect(ai.players).toEqual({ white: null, black: a.id });
    const two = board.newGame({ opponent: 'none' });
    expect(two.players).toEqual({ white: a.id, black: null });
    await ps.delete(a.id);
    expect(board.newGame({}).players).toEqual({ white: null, black: null });
  });
});
