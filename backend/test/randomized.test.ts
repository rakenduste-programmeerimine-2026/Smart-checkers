/**
 * Juhuslikud mängud: kontrollitakse, et laud, salvestus ja PDN püsivad kooskõlas
 * paljude erinevate seisude korral (ka löömised, tammid ja mängu lõpp).
 */
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { BoardController } from '../src/board/controller.js';
import { createEngineOpponent } from '../src/ai/opponent.js';
import { applyMove, formatMove, gameResult, initialPosition, legalMoves } from '../src/game/rules.js';
import { occupancyMask } from '../src/game/sensors.js';
import type { Move, Position } from '../src/game/types.js';
import { gameFromPdn, toPdn } from '../src/record/pdn.js';
import { buildApp } from '../src/server/app.js';
import { GameStore } from '../src/server/games.js';

/** Väike deterministlik juhuarvude generaator (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(list: T[], random: () => number): T => list[Math.floor(random() * list.length)]!;

/** Juhuslik mäng: käigud ja seisud. */
function randomGame(seed: number, maxPlies = 120): { moves: Move[]; positions: Position[] } {
  const random = rng(seed);
  const positions = [initialPosition()];
  const moves: Move[] = [];
  for (let i = 0; i < maxPlies; i++) {
    const pos = positions[positions.length - 1]!;
    if (gameResult(pos).status !== 'ongoing') break;
    const move = pick(legalMoves(pos), random);
    moves.push(move);
    positions.push(applyMove(pos, move));
  }
  return { moves, positions };
}

const SEEDS = Array.from({ length: 40 }, (_, i) => i + 1);
const engine = createEngineOpponent(() => 0);

describe('juhuslikud mängud laual', () => {
  it.each(SEEDS)('seeme %i: laud tunneb kõik käigud ära ka nupu tõstmise vahepealsete seisudega', (seed) => {
    const { moves, positions } = randomGame(seed);
    let t = 0;
    const store = new GameStore({ engine, claude: engine });
    const board = new BoardController('laud', store, { now: () => t, timing: { settleMs: 50, errorMs: 10_000 } });
    const game = board.newGame({ opponent: 'none' });
    const send = (mask: number) => {
      board.update({ mask });
      t += 60;
      return board.update({});
    };
    send(occupancyMask(initialPosition().board));
    expect(board.status().state).toBe('play');

    moves.forEach((move, i) => {
      const before = occupancyMask(positions[i]!.board);
      // Nupp tõstetakse üles: süttivad selle nupu sihtruudud.
      const lifted = send((before & ~(1 << move.from)) >>> 0);
      expect(lifted.leds.some((l) => l.color === '00C040')).toBe(true);
      // Löödud nupud võetakse ükshaaval ära (pooleli seis ei tohi käiku kirja panna).
      let mask = (before & ~(1 << move.from)) >>> 0;
      for (const sq of move.captures) {
        mask = (mask & ~(1 << sq)) >>> 0;
        send(mask);
        expect(game.history).toHaveLength(i);
      }
      send(occupancyMask(positions[i + 1]!.board));
      expect(game.history).toHaveLength(i + 1);
      expect(occupancyMask(game.position.board)).toBe(occupancyMask(positions[i + 1]!.board));
    });
    expect(store.result(game)).toEqual(gameResult(positions[positions.length - 1]!));
  });

  it.each(SEEDS.slice(0, 10))('seeme %i: mäng arvuti vastu laual lõpeb ilma vigadeta', async (seed) => {
    const random = rng(seed);
    let t = 0;
    const store = new GameStore({ engine, claude: engine });
    const board = new BoardController('laud', store, { now: () => t, timing: { settleMs: 50, errorMs: 10_000 } });
    const game = board.newGame({ opponent: 'engine', level: 'beginner' });
    const send = (mask: number) => {
      board.update({ mask });
      t += 60;
      return board.update({});
    };
    send(occupancyMask(initialPosition().board));
    for (let ply = 0; ply < 80 && !store.isOver(game); ply++) {
      if (store.canHumanMove(game)) {
        const move = pick(legalMoves(game.position), random);
        send(occupancyMask(applyMove(game.position, move).board));
      } else {
        await new Promise((r) => setImmediate(r));
        // AI käik tuleb laual järele teha.
        expect(board.status().state).toBe('pending-move');
        send(occupancyMask(game.position.board));
      }
      expect(board.status().boardPly).toBe(game.history.length);
    }
    expect(game.history.length).toBeGreaterThan(0);
  });
});

describe('juhuslikud mängud: salvestus ja PDN', () => {
  it.each(SEEDS)('seeme %i: PDN edasi-tagasi annab sama mängu', (seed) => {
    const { moves } = randomGame(seed);
    const store = new GameStore({ engine, claude: engine });
    const game = store.create({ opponent: null, level: 'medium', humanColor: 'white' });
    for (const m of moves) store.play(game, m);
    const pdn = toPdn(store.toRecord(game));
    const back = gameFromPdn(pdn);
    expect(back.moves.map((m) => m.text)).toEqual(game.history);
    expect(back.result()).toEqual(store.result(game));

    const restored = new GameStore({ engine, claude: engine }).restore(store.toRecord(game));
    expect(restored.history).toEqual(game.history);
    expect(restored.position).toEqual(game.position);
  });

  it.each(SEEDS.slice(0, 10))('seeme %i: käikude tagasivõtt viib algseisu', (seed) => {
    const { moves } = randomGame(seed, 30);
    const store = new GameStore({ engine, claude: engine });
    const game = store.create({ opponent: null, level: 'medium', humanColor: 'white' });
    for (const m of moves) store.play(game, m);
    while (store.undo(game) > 0);
    expect(game.history).toEqual([]);
    expect(game.position).toEqual(initialPosition());
  });
});

describe('vastupidavus', () => {
  let app: FastifyInstance;
  afterEach(async () => app?.close());

  it('juhuslikud maskid ja nupud ei too kunagi kaasa serveri viga', async () => {
    app = buildApp({ opponents: { engine, claude: engine }, board: { timing: { settleMs: 0, errorMs: 0 } } });
    const random = rng(99);
    await app.inject({ method: 'POST', url: '/api/board/laud1/games', payload: { opponent: 'engine' } });
    for (let i = 0; i < 300; i++) {
      const mask = Math.floor(random() * 0x100000000);
      const buttons = random() < 0.2 ? [pick([1, 2, 3], random)] : [];
      const res = await app.inject({ method: 'POST', url: '/api/board/laud1/state', payload: { mask, buttons } });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.lcd).toHaveLength(2);
      for (const line of body.lcd) expect(line).toMatch(/^[\x20-\x7e]{16}$/);
      for (const led of body.leds) expect(led.led).toBeLessThan(160);
    }
  });

  it('vigased kehad annavad 4xx, mitte 500', async () => {
    app = buildApp({ opponents: { engine, claude: engine } });
    const random = rng(7);
    const junk = () =>
      pick<unknown>(
        [null, 0, -1, 'x', '', [], {}, { move: 5 }, { move: 'z9-z9' }, { moves: 'c3-d4' }, { mask: -5 }, { mask: 2 ** 33 },
          { buttons: ['1'] }, { pdn: 5 }, { gameId: [] }, { opponent: 'jumal' }, { clockMinutes: 1.5 }],
        random,
      );
    const { game } = (await app.inject({ method: 'POST', url: '/api/games', payload: { opponent: 'none' } })).json();
    const urls = ['/api/games', `/api/games/${game.id}/moves`, '/api/ai/move', '/api/games/import', '/api/board/b/state', '/api/board/b/attach', '/api/board/b/games'];
    for (let i = 0; i < 200; i++) {
      const res = await app.inject({ method: 'POST', url: pick(urls, random), payload: junk() as object });
      expect(res.statusCode, res.body).toBeLessThan(500);
    }
  });
});
