import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createEngineOpponent } from '../../src/ai/opponent.js';
import { BoardController } from '../../src/board/controller.js';
import { applyMove, findMove, initialPosition } from '../../src/game/rules.js';
import { occupancyMask } from '../../src/game/sensors.js';
import type { Position } from '../../src/game/types.js';
import { buildApp } from '../../src/server/app.js';
import { GameStore } from '../../src/server/games.js';

const engine = createEngineOpponent(() => 0);
const INITIAL = occupancyMask(initialPosition().board);
const after = (pos: Position, move: string) => applyMove(pos, findMove(pos, move)!);

/** Kaks lauda ühe mänguga. */
const setupMatch = () => {
  let t = 0;
  const store = new GameStore({ engine, claude: engine }, undefined, { now: () => new Date(t) });
  const opts = { now: () => t, timing: { settleMs: 100, errorMs: 1000, messageMs: 100 } };
  const boards = new Map<string, BoardController>();
  const a = new BoardController('a', store, opts);
  const b = new BoardController('b', store, opts);
  boards.set('a', a).set('b', b);
  const game = store.create({ opponent: null, level: 'medium', humanColor: 'white' });
  a.joinMatch(game, 'white', 'b', () => boards.get('b'));
  b.joinMatch(game, 'black', 'a', () => boards.get('a'));
  const place = (board: BoardController, mask: number) => {
    board.update({ mask });
    t += 200;
    return board.update({});
  };
  return { store, game, a, b, place, tick: (ms: number) => (t += ms), boards };
};

describe('võrgumäng kahe laua vahel', () => {
  it('käik ühel laual süttib teisel ja tuleb järele teha', () => {
    const { game, a, b, place } = setupMatch();
    place(a, INITIAL);
    place(b, INITIAL);
    expect(a.update({}).lcd[0]).toBe('Sinu kord       ');
    expect(b.update({}).lcd[0]).toBe('Vastase kord    ');

    const p1 = after(initialPosition(), 'c3-d4');
    place(a, occupancyMask(p1.board));
    expect(game.history).toEqual(['c3-d4']);
    expect(a.update({}).lcd[0]).toBe('Vastase kord    ');
    // Teisel laual näidatakse käiku, mida järele teha.
    const pending = b.update({});
    expect(b.status().state).toBe('pending-move');
    expect(pending.leds.length).toBeGreaterThan(0);
    place(b, occupancyMask(p1.board));
    expect(b.status()).toMatchObject({ state: 'play', boardPly: 1 });
    expect(b.update({}).lcd[0]).toBe('Sinu kord       ');

    const p2 = after(p1, 'f6-e5');
    place(b, occupancyMask(p2.board));
    expect(game.history).toEqual(['c3-d4', 'f6-e5']);
    place(a, occupancyMask(p2.board));
    expect(a.status().boardPly).toBe(2);
  });

  it('vastase poole käiku sellelt laualt ei loeta ja vale seis näidatakse', () => {
    const { game, b, place, tick } = setupMatch();
    place(b, INITIAL);
    const p1 = after(initialPosition(), 'c3-d4');
    place(b, occupancyMask(p1.board));
    expect(game.history).toEqual([]);
    tick(2000);
    expect(b.update({}).leds.length).toBeGreaterThan(0);
  });

  it('näitab, kas vastane on võrgus', () => {
    const { a, b, place, tick } = setupMatch();
    place(b, INITIAL);
    place(a, INITIAL);
    expect(b.update({}).lcd[1]).not.toBe('Vastane eemal   ');
    expect(b.status().match).toEqual({ seat: 'black', peerId: 'a', peerOnline: true });
    tick(10_000);
    expect(b.update({}).lcd[1]).toBe('Vastane eemal   ');
  });

  it('viigipakkumine ja vastuvõtt nuppudega, tagasivõttu pole', () => {
    const { store, game, a, b, place, tick } = setupMatch();
    place(a, INITIAL);
    place(b, INITIAL);
    expect(a.update({ buttons: [2] }).lcd).toEqual(['Vorgumangus     ', 'tagasivottu pole']);
    tick(200);
    // Menüüst viigipakkumine (rida 8).
    a.update({ buttons: [3] });
    for (let i = 0; i < 8; i++) a.update({ buttons: [1] });
    expect(a.update({ buttons: [2] }).lcd).toEqual(['Viik pakutud    ', 'Ootan vastast   ']);
    expect(game.drawOffer).toBe('white');
    expect(b.update({}).lcd).toEqual(['Vastane: viik?  ', 'B2 jah   B1 ei  ']);
    b.update({ buttons: [1] });
    expect(game.drawOffer).toBeNull();
    store.offerDraw(game, 'white');
    b.update({ buttons: [2] });
    expect(store.result(game)).toEqual({ status: 'draw', reason: 'agreement' });
  });

  it('alistumine menüüst kehtib laua värvi kohta', () => {
    const { store, game, b, place } = setupMatch();
    place(b, INITIAL);
    b.update({ buttons: [3] });
    for (let i = 0; i < 9; i++) b.update({ buttons: [1] });
    b.update({ buttons: [2] });
    expect(store.result(game)).toEqual({ status: 'win', winner: 'white', reason: 'resign' });
  });

  it('uus mäng laualt lõpetab võrgumängu sidumise', () => {
    const { b } = setupMatch();
    b.newGame({ opponent: 'engine' });
    expect(b.status().match).toBeNull();
  });
});

describe('POST /api/matches', () => {
  let app: FastifyInstance;
  afterEach(async () => app?.close());

  it('seob kaks lauda ühe mänguga', async () => {
    app = buildApp({ opponents: { engine, claude: engine } });
    const res = await app.inject({ method: 'POST', url: '/api/matches', payload: { white: 'laud1', black: 'laud2', clockMinutes: 5 } });
    expect(res.statusCode).toBe(201);
    const { gameId, boards } = res.json();
    expect(boards[0]).toMatchObject({ id: 'laud1', gameId, match: { seat: 'white', peerId: 'laud2', peerOnline: false } });
    expect(boards[1]).toMatchObject({ id: 'laud2', gameId, match: { seat: 'black', peerId: 'laud1' } });
    const game = (await app.inject({ method: 'GET', url: `/api/games/${gameId}` })).json().game;
    expect(game).toMatchObject({ opponent: 'none', clock: { initialMs: 300_000 } });
    expect((await app.inject({ method: 'POST', url: '/api/matches', payload: { white: 'x', black: 'x' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/matches', payload: { white: '../x', black: 'y' } })).statusCode).toBe(400);
  });
});
