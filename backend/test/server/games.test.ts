import { describe, expect, it } from 'vitest';
import { createEngineOpponent } from '../../src/ai/opponent.js';
import { findMove } from '../../src/game/rules.js';
import { GameStore } from '../../src/server/games.js';

const engine = createEngineOpponent(() => 0);
const store = () => new GameStore({ engine, claude: engine });

describe('GameStore', () => {
  it('hoiab kõiki seise ja võtab kahe mängija mängus ühe käigu tagasi', () => {
    const s = store();
    const game = s.create({ opponent: null, level: 'medium', humanColor: 'white' });
    for (const m of ['c3-d4', 'f6-e5']) s.play(game, findMove(game.position, m)!);
    expect(game.positions).toHaveLength(3);
    expect(s.undo(game)).toBe(1);
    expect(game.history).toEqual(['c3-d4']);
    expect(game.position).toBe(game.positions[1]);
  });

  it('AI vastu võtab tagasi inimese käigu koos AI vastusega', async () => {
    const s = store();
    const game = s.create({ opponent: 'engine', level: 'beginner', humanColor: 'white' });
    s.play(game, findMove(game.position, 'c3-d4')!);
    await s.aiTurn(game);
    expect(game.history).toHaveLength(2);
    expect(s.undo(game)).toBe(2);
    expect(game.history).toEqual([]);
    expect(s.undo(game)).toBe(0);
  });

  it('ei võta tagasi AI esimest käiku, kui inimene on must', async () => {
    const s = store();
    const game = s.create({ opponent: 'engine', level: 'beginner', humanColor: 'black' });
    await s.aiTurn(game);
    expect(s.undo(game)).toBe(0);
    expect(game.history).toHaveLength(1);
  });

  it('male kell arvestab mõlema poole aega ja taastub kirjest', () => {
    let t = Date.parse('2026-11-26T10:00:00Z');
    const s = new GameStore({ engine, claude: engine }, undefined, { now: () => new Date(t) });
    const game = s.create({ opponent: null, level: 'medium', humanColor: 'white', clockMs: 60_000 });
    t += 5_000; // valge mõtleb enne esimest käiku: kell veel ei käi
    s.play(game, findMove(game.position, 'c3-d4')!);
    t += 20_000;
    s.play(game, findMove(game.position, 'f6-e5')!);
    t += 7_000;
    expect(s.remaining(game, 'black')).toBe(40_000);
    expect(s.remaining(game, 'white')).toBe(53_000);
    s.play(game, findMove(game.position, 'd4:f6')!);
    expect(game.clock).toMatchObject({ white: 53_000, black: 40_000 });

    t += 41_000;
    expect(s.result(game)).toEqual({ status: 'win', winner: 'white', reason: 'time' });
    const record = s.toRecord(game);
    expect(record).toMatchObject({ flagged: 'black', settings: { clockMs: 60_000 } });
    const restored = new GameStore({ engine, claude: engine }).restore(record);
    expect(restored.clock).toMatchObject({ flagged: 'black', black: 0 });
    expect(new GameStore({ engine, claude: engine }).result(restored)).toMatchObject({ reason: 'time' });
  });

  it('piirab kella pikkust ja eirab nulli', () => {
    const s = store();
    expect(s.create({ opponent: null, level: 'medium', humanColor: 'white', clockMs: 0 }).clock).toBeNull();
    expect(s.create({ opponent: null, level: 'medium', humanColor: 'white', clockMs: 1e12 }).clock?.initialMs).toBe(3 * 3600_000);
  });

  it('keeldub vigasest salvestatud mängust', () => {
    expect(() =>
      store().restore({ id: 'x', meta: { startedAt: '2026-01-01T00:00:00Z' }, moves: [{ text: 'c3-c4', at: '' }], result: { status: 'ongoing' } }),
    ).toThrow(/vigane käik/);
  });
});
