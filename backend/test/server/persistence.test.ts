import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createEngineOpponent } from '../../src/ai/opponent.js';
import { GameStore as RecordStore } from '../../src/record/store.js';
import { buildApp } from '../../src/server/app.js';

let dir: string;
const apps: FastifyInstance[] = [];
const engine = createEngineOpponent(() => 0);
const start = (maxGames?: number) => {
  const app = buildApp({ opponents: { engine, claude: engine }, records: new RecordStore(dir), maxGames });
  apps.push(app);
  return app;
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'kabe-'));
});
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  await rm(dir, { recursive: true, force: true });
});

const newGame = async (app: FastifyInstance, payload: object = { opponent: 'none' }) =>
  (await app.inject({ method: 'POST', url: '/api/games', payload })).json().game;
const move = (app: FastifyInstance, id: string, m: string) =>
  app.inject({ method: 'POST', url: `/api/games/${id}/moves`, payload: { move: m } });

describe('mängude salvestamine', () => {
  it('salvestab mängu kettale ja jätkab seda pärast serveri taaskäivitust', async () => {
    const first = start();
    const game = await newGame(first, { opponent: 'engine', level: 'beginner' });
    await move(first, game.id, 'c3-d4');
    await first.close();
    expect(await readdir(dir)).toEqual([`${game.id}.json`]);

    const second = start();
    const loaded = (await second.inject({ method: 'GET', url: `/api/games/${game.id}` })).json().game;
    expect(loaded).toMatchObject({ opponent: 'engine', level: 'beginner', humanColor: 'white' });
    expect(loaded.history).toHaveLength(2);
    expect(loaded.history[0]).toBe('c3-d4');
    expect(loaded.moveTimes).toHaveLength(2);
    const next = await move(second, game.id, loaded.legalMoves[0]);
    expect(next.statusCode).toBe(200);
  });

  it('näitab mängude nimekirja, uuemad eespool', async () => {
    const app = start();
    const a = await newGame(app);
    await move(app, a.id, 'c3-d4');
    const b = await newGame(app);
    const res = await app.inject({ method: 'GET', url: '/api/games?limit=10' });
    const games = res.json().games;
    expect(games.map((g: { id: string }) => g.id).sort()).toEqual([a.id, b.id].sort());
    expect(games.find((g: { id: string }) => g.id === a.id)).toMatchObject({ moveCount: 1, result: { status: 'ongoing' } });
    expect((await app.inject({ method: 'GET', url: '/api/games?limit=0' })).statusCode).toBe(400);
  });

  it('ekspordib ja impordib PDN-i', async () => {
    const app = start();
    const game = await newGame(app);
    for (const m of ['c3-d4', 'f6-e5', 'd4:f6']) await move(app, game.id, m);
    const pdn = await app.inject({ method: 'GET', url: `/api/games/${game.id}/pdn` });
    expect(pdn.headers['content-type']).toContain('application/x-pdn');
    expect(pdn.headers['content-disposition']).toContain('.pdn');
    expect(pdn.body).toContain('[GameType "25"]');
    expect(pdn.body).toContain('1. c3-d4 f6-e5 2. d4:f6');

    const imported = await app.inject({ method: 'POST', url: '/api/games/import', payload: { pdn: pdn.body } });
    expect(imported.statusCode).toBe(201);
    expect(imported.json().game).toMatchObject({ opponent: 'none', history: ['c3-d4', 'f6-e5', 'd4:f6'] });

    const bad = await app.inject({ method: 'POST', url: '/api/games/import', payload: { pdn: '1. c3-c4 *' } });
    expect(bad.statusCode).toBe(422);
  });

  it('kustutab mängu ja ei luba failiteedest välja', async () => {
    const app = start();
    const game = await newGame(app);
    expect((await app.inject({ method: 'DELETE', url: `/api/games/${game.id}` })).statusCode).toBe(204);
    expect((await app.inject({ method: 'GET', url: `/api/games/${game.id}` })).statusCode).toBe(404);
    expect(await readdir(dir)).toEqual([]);
    expect((await app.inject({ method: 'GET', url: '/api/games/..%2F..%2Fetc%2Fpasswd' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: '/api/games/olematu' })).statusCode).toBe(404);
  });

  it('hoiab mälus piiratud arvu mänge, vanemad laaditakse kettalt', async () => {
    const app = start(2);
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push((await newGame(app)).id);
    const res = await app.inject({ method: 'GET', url: `/api/games/${ids[0]}` });
    expect(res.statusCode).toBe(200);
  });
});

describe('kordus laual', () => {
  it('näitab salvestatud mängu käike ükshaaval', async () => {
    const app = start();
    const game = await newGame(app);
    for (const m of ['c3-d4', 'f6-e5']) await move(app, game.id, m);
    const replay = await app.inject({ method: 'POST', url: '/api/board/laud1/replay', payload: { gameId: game.id } });
    expect(replay.json().board).toMatchObject({ state: 'replay', replayPly: 0 });
    expect(replay.json().display.lcd).toEqual(['Kordus 1/2      ', 'c3-d4           ']);
    const state = (buttons: number[]) =>
      app.inject({ method: 'POST', url: '/api/board/laud1/state', payload: { mask: 0, buttons } });
    expect((await state([2])).json().lcd[1]).toBe('f6-e5           ');
    expect((await state([2, 2])).json().lcd).toEqual(['Kordus 2/2      ', 'Pooleli         ']);
    expect((await state([1])).json().lcd[0]).toBe('Kordus 2/2      ');
    expect((await state([3])).json().lcd[0]).not.toContain('Kordus');
    const missing = await app.inject({ method: 'POST', url: '/api/board/laud1/replay', payload: { gameId: 'x' } });
    expect(missing.statusCode).toBe(404);
  });
});
