import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AI_RATINGS, START_RATING, expectedScore, newRating, rankTitle } from '../../src/players/elo.js';
import { MAX_HISTORY, PlayerError, PlayerStore } from '../../src/players/store.js';

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
const tempFile = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'players-'));
  dirs.push(dir);
  return join(dir, 'sub', 'players.data');
};
const at = '2026-11-26T10:00:00.000Z';

describe('Elo', () => {
  it('ootus ja uus reiting', () => {
    expect(expectedScore(1200, 1200)).toBe(0.5);
    expect(expectedScore(1600, 1200)).toBeCloseTo(0.909, 2);
    expect(newRating(1200, 1200, 1, 0)).toBe(1220); // K = 40 alguses
    expect(newRating(1200, 1200, 1, 20)).toBe(1212); // K = 24 hiljem
    expect(newRating(1200, 1200, 0.5, 20)).toBe(1200);
    expect(newRating(1200, AI_RATINGS.engine.strong, 1, 20)).toBeGreaterThan(newRating(1200, AI_RATINGS.engine.beginner, 1, 20));
  });

  it('tiitlid', () => {
    expect(rankTitle(900)).toBe('Algaja');
    expect(rankTitle(START_RATING)).toBe('Harrastaja');
    expect(rankTitle(1350)).toBe('Edasijõudnu');
    expect(rankTitle(1550)).toBe('Ekspert');
    expect(rankTitle(1900)).toBe('Meister');
  });
});

describe('PlayerStore', () => {
  it('loob mängija, kontrollib nime ja leiab nime järgi', async () => {
    const store = new PlayerStore();
    const maik = await store.create('  Maik   H ');
    expect(maik).toMatchObject({ name: 'Maik H', rating: START_RATING, stats: { games: 0 } });
    await expect(store.create('maik h')).rejects.toMatchObject({ statusCode: 409 });
    await expect(store.create('')).rejects.toBeInstanceOf(PlayerError);
    await expect(store.create('<script>')).rejects.toMatchObject({ statusCode: 400 });
    await expect(store.create('x'.repeat(25))).rejects.toMatchObject({ statusCode: 400 });
    expect(store.findByName('MAIK H')?.id).toBe(maik.id);
    expect(await store.create('Õie Ülle')).toMatchObject({ name: 'Õie Ülle' });
  });

  it('nimetab ümber ja kustutab', async () => {
    const store = new PlayerStore();
    const a = await store.create('Anna');
    await store.create('Bert');
    expect((await store.rename(a.id, 'Anu')).name).toBe('Anu');
    await expect(store.rename(a.id, 'bert')).rejects.toMatchObject({ statusCode: 409 });
    await expect(store.rename(a.id, '!!')).rejects.toMatchObject({ statusCode: 400 });
    await expect(store.rename('puudub', 'X')).rejects.toMatchObject({ statusCode: 404 });
    expect(await store.rename(a.id, 'anu')).toMatchObject({ name: 'anu' });
    expect(await store.delete(a.id)).toBe(true);
    expect(await store.delete(a.id)).toBe(false);
    expect(await store.get(a.id)).toBeUndefined();
  });

  it('kannab tulemused kirja: statistika, seeria ja ajalugu', async () => {
    const store = new PlayerStore();
    const p = await store.create('Mari');
    const result = (outcome: 'win' | 'loss' | 'draw', key = 'engine:medium') =>
      store.record([{ playerId: p.id, opponentRating: 1200, opponentKey: key, outcome, gameId: 'g', at }]);
    await result('win');
    await result('win');
    expect(p.stats).toMatchObject({ games: 2, wins: 2, streak: 2 });
    await result('loss', 'claude:strong');
    expect(p.stats.streak).toBe(-1);
    await result('loss');
    expect(p.stats.streak).toBe(-2);
    await result('draw');
    expect(p.stats).toMatchObject({ games: 5, wins: 2, losses: 2, draws: 1, streak: 0 });
    expect(p.stats.byOpponent).toEqual({
      'engine:medium': { wins: 2, losses: 1, draws: 1 },
      'claude:strong': { wins: 0, losses: 1, draws: 0 },
    });
    expect(p.history).toHaveLength(5);
    expect(p.bestRating).toBeGreaterThan(START_RATING);
    // Tundmatu mängija jäetakse vahele.
    await store.record([{ playerId: 'puudub', opponentRating: 1200, opponentKey: 'human', outcome: 'win', gameId: 'g', at }]);
  });

  it('ajalugu on piiratud', async () => {
    const store = new PlayerStore();
    const p = await store.create('Pikk');
    for (let i = 0; i < MAX_HISTORY + 5; i++) {
      await store.record([{ playerId: p.id, opponentRating: 1200, opponentKey: 'human', outcome: 'draw', gameId: `g${i}`, at }]);
    }
    expect(p.history).toHaveLength(MAX_HISTORY);
    expect(p.history[0]!.gameId).toBe('g5');
  });

  it('edetabel järjestab reitingu, mängude arvu ja nime järgi', async () => {
    const store = new PlayerStore();
    const a = await store.create('Aadu');
    const b = await store.create('Beti');
    const c = await store.create('Cecilia');
    await store.record([{ playerId: c.id, opponentRating: 1200, opponentKey: 'human', outcome: 'win', gameId: 'g', at }]);
    await store.record([{ playerId: b.id, opponentRating: 1200, opponentKey: 'human', outcome: 'draw', gameId: 'g', at }]);
    const board = await store.leaderboard();
    expect(board.map((p) => [p.rank, p.name])).toEqual([
      [1, 'Cecilia'],
      [2, 'Beti'],
      [3, 'Aadu'],
    ]);
    expect(board[0]).not.toHaveProperty('history');
    expect(board[0]!.title).toBe('Harrastaja');
    expect(await store.leaderboard(1)).toHaveLength(1);
    expect((await store.publicPlayer(a.id))!.rank).toBe(3);
    expect(await store.publicPlayer('puudub')).toBeUndefined();
  });

  it('salvestab faili ja loeb uuesti', async () => {
    const file = await tempFile();
    const store = new PlayerStore(file, () => new Date(at));
    const p = await store.create('Kalle');
    await store.record([{ playerId: p.id, opponentRating: 1400, opponentKey: 'claude:medium', outcome: 'win', gameId: 'g1', at }]);
    const saved = JSON.parse(await readFile(file, 'utf8'));
    expect(saved.players).toHaveLength(1);
    const again = new PlayerStore(file);
    const loaded = await again.get(p.id);
    expect(loaded).toMatchObject({ name: 'Kalle', createdAt: at, stats: { wins: 1 } });
    expect(loaded!.rating).toBe(p.rating);
    // Puuduv fail = tühi edetabel.
    expect(await new PlayerStore(join(file, '..', 'none.data')).leaderboard()).toEqual([]);
  });
});
