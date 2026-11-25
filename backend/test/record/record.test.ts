import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyMove, findMove, initialPosition, legalMoves } from '../../src/game/rules.js';
import { occupancyMask } from '../../src/game/sensors.js';
import { parseSquare } from '../../src/game/squares.js';
import type { Position } from '../../src/game/types.js';
import { Game } from '../../src/record/game.js';
import { gameFromPdn, parsePdn, toPdn } from '../../src/record/pdn.js';
import { GameStore } from '../../src/record/store.js';
import { BoardTracker } from '../../src/record/tracker.js';

const OPENING = ['c3-d4', 'f6-e5', 'd4:f6'];
const fixedNow = (): Date => new Date('2026-11-25T20:00:00.000Z');

const after = (moves: string[]): Position =>
  moves.reduce((pos, text) => {
    const move = findMove(pos, text);
    if (!move) throw new Error(text);
    return applyMove(pos, move);
  }, initialPosition());

const bit = (name: string): number => 1 << (parseSquare(name) as number);

describe('Game', () => {
  it('paneb käigud kirja ja annab seisu', () => {
    const game = new Game({ now: fixedNow });
    for (const m of OPENING) game.play(m);
    expect(game.moves.map((m) => m.text)).toEqual(OPENING);
    expect(game.position).toEqual(after(OPENING));
    expect(game.position.turn).toBe('black');
  });

  it('keeldub vigasest käigust', () => {
    const game = new Game();
    expect(() => game.play('c3-c4')).toThrow(/Vigane käik/);
    expect(() => game.play('a3-b4-c5')).toThrow();
    expect(game.moves).toHaveLength(0);
  });

  it('löömise vahepealsed ruudud võib ära jätta, logisse läheb täiskuju', () => {
    const game = new Game();
    game.play('c3-d4');
    game.play('f6-e5');
    game.play('d4:f6');
    expect(game.moves[2]?.text).toBe('d4:f6');
  });

  it('võtab käigu tagasi', () => {
    const game = new Game();
    game.play('c3-d4');
    game.play('f6-e5');
    expect(game.undo()).toBe(true);
    expect(game.position).toEqual(after(['c3-d4']));
    expect(game.undo()).toBe(true);
    expect(game.undo()).toBe(false);
  });

  it('taastub kirjest', () => {
    const game = new Game({ meta: { white: 'Maik', black: 'AI' }, now: fixedNow });
    for (const m of OPENING) game.play(m);
    const copy = Game.fromRecord(JSON.parse(JSON.stringify(game.toRecord())));
    expect(copy.toRecord()).toEqual(game.toRecord());
    expect(copy.position).toEqual(game.position);
  });
});

describe('BoardTracker', () => {
  it('paneb käigu kirja alles siis, kui mask on püsinud', () => {
    const game = new Game();
    const tracker = new BoardTracker(game, { stableMs: 300 });
    const start = occupancyMask(initialPosition().board);
    expect(tracker.update(start, 0)).toEqual({ kind: 'pending' });
    expect(tracker.update(start, 400)).toEqual({ kind: 'unchanged' });

    // Nupp tõstetakse c3-lt üles: hetkeks pooleli seis.
    const lifted = start & ~bit('c3');
    expect(tracker.update(lifted, 500).kind).toBe('pending');
    const target = occupancyMask(after(['c3-d4']).board);
    expect(tracker.update(target, 600)).toEqual({ kind: 'pending' });
    expect(tracker.update(target, 700)).toEqual({ kind: 'pending' });
    const event = tracker.update(target, 950);
    expect(event).toMatchObject({ kind: 'move', text: 'c3-d4' });
    // Sama maski kordamine ei tee uut käiku.
    expect(tracker.update(target, 2000)).toEqual({ kind: 'unchanged' });
    expect(game.moves.map((m) => m.text)).toEqual(['c3-d4']);
  });

  it('teatab püsivast vigasest seisust ja jätkab, kui laud parandatakse', () => {
    const game = new Game();
    const tracker = new BoardTracker(game, { stableMs: 100 });
    const start = occupancyMask(initialPosition().board);
    const lifted = start & ~bit('c3');
    tracker.update(lifted, 0);
    expect(tracker.update(lifted, 200)).toEqual({
      kind: 'mismatch',
      missing: [parseSquare('c3')],
      extra: [],
    });
    tracker.update(start, 300);
    expect(tracker.update(start, 500)).toEqual({ kind: 'unchanged' });
  });

  it('tunneb löömise ära, kui löödud nupp on lauast eemaldatud', () => {
    const game = new Game();
    const tracker = new BoardTracker(game, { stableMs: 50 });
    let t = 0;
    const settle = (mask: number) => {
      tracker.update(mask, (t += 10));
      return tracker.update(mask, (t += 100));
    };
    settle(occupancyMask(initialPosition().board));
    expect(settle(occupancyMask(after(OPENING.slice(0, 1)).board))).toMatchObject({ text: 'c3-d4' });
    expect(settle(occupancyMask(after(OPENING.slice(0, 2)).board))).toMatchObject({ text: 'f6-e5' });
    // Valge hüppas f6-le, aga löödud nupp e5 on veel laual.
    const jumped = (occupancyMask(after(OPENING.slice(0, 2)).board) & ~bit('d4')) | bit('f6');
    expect(settle(jumped).kind).toBe('mismatch');
    expect(settle(occupancyMask(after(OPENING).board))).toMatchObject({ kind: 'move', text: 'd4:f6' });
  });
});

describe('PDN', () => {
  it('ekspordib päised ja käigud', () => {
    const game = new Game({ meta: { white: 'Maik', black: 'AI "strong"' }, now: fixedNow });
    for (const m of OPENING) game.play(m);
    const pdn = toPdn(game.toRecord());
    expect(pdn).toContain('[White "Maik"]');
    expect(pdn).toContain('[Black "AI \\"strong\\""]');
    expect(pdn).toContain('[Date "2026.11.25"]');
    expect(pdn).toContain('[GameType "25"]');
    expect(pdn).toContain('[Result "*"]');
    expect(pdn).toContain('1. c3-d4 f6-e5 2. d4:f6 *');
  });

  it('import ja eksport annavad sama mängu', () => {
    const game = new Game({ meta: { white: 'Maik', black: 'AI' }, now: fixedNow });
    for (const m of OPENING) game.play(m);
    const copy = gameFromPdn(toPdn(game.toRecord()));
    expect(copy.moves.map((m) => m.text)).toEqual(OPENING);
    expect(copy.meta).toMatchObject({ white: 'Maik', black: 'AI', startedAt: '2026-11-25T00:00:00.000Z' });
    expect(copy.position).toEqual(game.position);
  });

  it('jätab kommentaarid ja variandid vahele', () => {
    const parsed = parsePdn('[Event "x"]\n1. c3-d4 {hea} f6-e5 (1... b6-a5 2. d4-c5) 2. d4:f6! 1-0');
    expect(parsed).toEqual({ headers: { Event: 'x' }, moves: OPENING, result: '1-0' });
  });

  it('keeldub vigasest käigust', () => {
    expect(() => gameFromPdn('1. c3-d4 f6-f5 *')).toThrow();
    expect(() => parsePdn('1. c3-d4 hello *')).toThrow(/Tundmatu/);
  });

  it('pikk mäng murtakse ridadeks', () => {
    const game = new Game();
    for (let i = 0; i < 40 && game.result().status === 'ongoing'; i++) {
      const move = legalMoves(game.position)[0];
      if (!move) break;
      game.play(move);
    }
    expect(game.moves.length).toBeGreaterThan(20);
    const lines = toPdn(game.toRecord()).trimEnd().split('\n');
    expect(lines.every((l) => l.length <= 80)).toBe(true);
  });
});

describe('GameStore', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'smart-checkers-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('salvestab, loeb, loetleb ja kustutab', async () => {
    const store = new GameStore(join(dir, 'games'));
    expect(await store.list()).toEqual([]);

    const older = new Game({ id: 'older', meta: { startedAt: '2026-11-24T10:00:00.000Z' } });
    older.play('c3-d4');
    const newer = new Game({ id: 'newer', meta: { startedAt: '2026-11-25T10:00:00.000Z' } });
    await store.save(older.toRecord());
    await store.save(newer.toRecord());

    expect(await store.load('older')).toEqual(older.toRecord());
    expect(await store.load('missing')).toBeNull();
    expect((await store.list()).map((s) => [s.id, s.moveCount])).toEqual([
      ['newer', 0],
      ['older', 1],
    ]);

    // Ülekirjutamine uuendab sama faili.
    older.play('f6-e5');
    await store.save(older.toRecord());
    expect((await store.load('older'))?.moves).toHaveLength(2);

    expect(await store.delete('older')).toBe(true);
    expect(await store.delete('older')).toBe(false);
    expect((await store.list()).map((s) => s.id)).toEqual(['newer']);
  });

  it('keeldub ohtlikust id-st', async () => {
    const store = new GameStore(dir);
    await expect(store.load('../secret')).rejects.toThrow(/Vigane mängu id/);
  });
});
