import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createEngineOpponent } from '../../src/ai/opponent.js';
import { BoardController, ONLINE_MS } from '../../src/board/controller.js';
import { FLICKER_LIMIT, HealthMonitor, MAX_LOG } from '../../src/board/health.js';
import { initialPosition } from '../../src/game/rules.js';
import { occupancyMask } from '../../src/game/sensors.js';
import { parseSquare } from '../../src/game/squares.js';
import { buildApp } from '../../src/server/app.js';
import { GameStore } from '../../src/server/games.js';

const bit = (name: string) => (1 << parseSquare(name)!) >>> 0;
const engine = createEngineOpponent(() => 0);

describe('HealthMonitor', () => {
  it('loendab päringuid, vahesid ja katkestusi', () => {
    const h = new HealthMonitor(5000);
    expect(h.report(0)).toMatchObject({ online: false, requests: 0, avgIntervalMs: null, maxGapMs: null, disconnects: 0 });
    h.request(0, undefined);
    h.request(200, undefined);
    h.request(400, undefined);
    expect(h.report(500)).toMatchObject({ online: true, requests: 3, avgIntervalMs: 200, maxGapMs: 200 });
    h.request(10_400, undefined);
    const r = h.report(10_500);
    expect(r.disconnects).toBe(1);
    expect(r.maxGapMs).toBe(10_000);
    expect(r.log.map((e) => e.event)).toEqual(['online', 'offline', 'online']);
    expect(r.log[1]!.at).toBe(new Date(5400).toISOString());
    expect(h.report(20_000).online).toBe(false);
  });

  it('logi on piiratud', () => {
    const h = new HealthMonitor(10);
    for (let i = 0; i < MAX_LOG; i++) h.request(i * 100, undefined);
    expect(h.report(0).log).toHaveLength(MAX_LOG);
  });

  it('leiab väriseva lüliti ja loeb nähtud ruute', () => {
    const h = new HealthMonitor(5000);
    let t = 0;
    h.request(t, 0);
    for (let i = 0; i < FLICKER_LIMIT + 1; i++) {
      h.request((t += 50), bit('c3'));
      h.request((t += 50), 0);
    }
    h.request((t += 1000), bit('e3'));
    h.request((t += 1000), 0);
    const r = h.report(t);
    expect(r.sensors.flickering).toEqual(['c3']);
    expect(r.sensors.seen).toBe(2);
    expect(h.seen(parseSquare('e3')!)).toBe(true);
    h.resetSensors();
    expect(h.report(t).sensors).toEqual({ seen: 0, flickering: [] });
    h.request(t, bit('h8'));
    expect(h.seen(parseSquare('h8')!)).toBe(true);
  });
});

describe('laua testirežiim', () => {
  it('näitab andureid ja LED-teste ning naaseb mängu', () => {
    let t = 0;
    const store = new GameStore({ engine, claude: engine });
    const board = new BoardController('laud1', store, { now: () => t, timing: { settleMs: 100 } });
    const game = board.newGame({ opponent: 'none' });
    board.update({ buttons: [3] });
    for (let i = 0; i < 10; i++) board.update({ buttons: [1] });
    expect(board.update({}).lcd[0]).toBe('>Laua test      ');
    board.update({ buttons: [2], mask: bit('a1') });
    expect(board.status().state).toBe('diagnostics');
    t += 200;
    let shown = board.update({ mask: bit('a1') });
    expect(shown.lcd).toEqual(['Andurid 1/32    ', 'B1 LED  B3 valja']);
    const colors = Object.fromEntries(shown.leds.map((l) => [l.square, l.color + l.mode]));
    expect(colors.a1).toBe('FFFFFFsolid');
    expect(colors.h8).toBe('FF0000blink');
    shown = board.update({ mask: bit('c1') });
    expect(Object.fromEntries(shown.leds.map((l) => [l.square, l.color])).a1).toBe('00C040');
    // Mask ei tee diagnostikas käiku.
    t += 500;
    board.update({ mask: occupancyMask(initialPosition().board) });
    expect(game.history).toEqual([]);
    const ledTest = board.update({ buttons: [1] });
    expect(ledTest.lcd[0]).toBe('LED test        ');
    expect(ledTest.leds).toHaveLength(32);
    board.update({ buttons: [1] });
    board.update({ buttons: [2] });
    expect(board.update({ mask: 0 }).lcd[0]).toBe('Andurid 0/32    ');
    board.update({ buttons: [3] });
    expect(board.status().state).toBe('setup');
  });

  it('näitab värisevat lülitit', () => {
    let t = 0;
    const board = new BoardController('laud1', new GameStore({ engine, claude: engine }), { now: () => t });
    board.update({ buttons: [3] });
    for (let i = 0; i < 10; i++) board.update({ buttons: [1] });
    board.update({ buttons: [2] });
    for (let i = 0; i < 4; i++) {
      t += 50;
      board.update({ mask: bit('d2') });
      t += 50;
      board.update({ mask: 0 });
    }
    expect(board.update({}).lcd[1]).toBe('Varin: d2       ');
    // Ilma mänguta B3 lihtsalt väljub.
    board.update({ buttons: [3] });
    expect(board.status().state).toBe('no-game');
  });
});

describe('GET /api/board/:boardId/health', () => {
  let app: FastifyInstance;
  afterEach(async () => app?.close());

  it('annab ühenduse ja andurite ülevaate', async () => {
    app = buildApp({ opponents: { engine, claude: engine } });
    await app.inject({ method: 'POST', url: '/api/board/laud1/state', payload: { mask: 0 } });
    await app.inject({ method: 'POST', url: '/api/board/laud1/state', payload: { mask: 5 } });
    const res = await app.inject({ method: 'GET', url: '/api/board/laud1/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json().health).toMatchObject({ online: true, requests: 2, disconnects: 0, sensors: { seen: 2, flickering: [] } });
    expect(ONLINE_MS).toBe(5000);
  });
});
