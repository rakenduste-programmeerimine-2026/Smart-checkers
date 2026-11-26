import { beforeEach, describe, expect, it } from 'vitest';
import { BoardController } from '../../src/board/controller.js';
import { ledIndex } from '../../src/board/display.js';
import { createEngineOpponent, type Opponent, type OpponentMove } from '../../src/ai/opponent.js';
import { applyMove, findMove, formatMove, initialPosition, legalMoves, setupPosition } from '../../src/game/rules.js';
import { occupancyMask } from '../../src/game/sensors.js';
import { parseSquare } from '../../src/game/squares.js';
import type { Position } from '../../src/game/types.js';
import { GameStore, type Game } from '../../src/server/games.js';

const bit = (name: string) => (1 << parseSquare(name)!) >>> 0;
const INITIAL = occupancyMask(initialPosition().board);
const flush = () => new Promise((resolve) => setImmediate(resolve));

/** "Claude", kes valib alati esimese seadusliku käigu. */
const firstMove: Opponent = {
  kind: 'claude',
  async chooseMove(pos) {
    const move = legalMoves(pos)[0];
    return move ? { move, notation: formatMove(move), source: 'claude' } : null;
  },
};

let t = 0;
let store: GameStore;
let board: BoardController;

/** Saadab maski ja ootab, kuni see on stabiilne. */
const place = (mask: number) => {
  board.update({ mask });
  t += 200;
  return board.update({});
};
const press = (...buttons: (1 | 2 | 3)[]) => board.update({ buttons });
const ledsOf = (display: ReturnType<typeof board.update>) =>
  Object.fromEntries(display.leds.map((l) => [l.square, `${l.color}/${l.mode}`]));
const maskOf = (pos: Position) => occupancyMask(pos.board);

beforeEach(() => {
  t = 0;
  store = new GameStore({ engine: createEngineOpponent(() => 0), claude: firstMove }, undefined, { now: () => new Date(t) });
  board = new BoardController('laud1', store, { now: () => t, timing: { settleMs: 100, errorMs: 1000 } });
});

/** Uus mäng ja laud algseisus. */
const startGame = (settings: Parameters<BoardController['newGame']>[0] = {}): Game => {
  const game = board.newGame(settings);
  place(INITIAL);
  return game;
};

describe('BoardController', () => {
  it('ilma mänguta näitab ootel olekut ja B2 alustab mängu', () => {
    const idle = board.update({ mask: 0 });
    expect(idle.effect).toBe('idle');
    expect(board.status().state).toBe('no-game');
    press(2);
    expect(board.status().gameId).not.toBeNull();
  });

  it('uue mängu alguses näitab puuduvaid nuppe, kuni laud on algseisus', () => {
    board.newGame({ opponent: 'none' });
    const empty = place(INITIAL & ~bit('c3') | bit('d4'));
    expect(empty.lcd).toEqual(['Sea nupud paika ', 'Puudu 1 liig 1  ']);
    expect(ledsOf(empty)).toEqual({ c3: 'FF0000/blink', d4: 'B000FF/blink' });
    const ready = place(INITIAL);
    expect(board.status().state).toBe('play');
    expect(ready.lcd[0]).toBe('Valge kord      ');
    expect(ready.leds).toEqual([]);
  });

  it('tõstetud nupu sihtruudud süttivad', () => {
    startGame({ opponent: 'none' });
    const lifted = place(INITIAL & ~bit('c3'));
    expect(ledsOf(lifted)).toEqual({ c3: 'FFFFFF/solid', b4: '00C040/solid', d4: '00C040/solid' });
    expect(lifted.lcd[1]).toBe('2 voimalust     ');
  });

  it('tunneb ära inimese käigu, näitab AI vastust ja ootab, kuni see laual tehtud', async () => {
    const game = startGame({ opponent: 'claude' });
    const afterHuman = applyMove(initialPosition(), findMove(initialPosition(), 'c3-d4')!);
    place(maskOf(afterHuman));
    expect(game.history).toEqual(['c3-d4']);
    await flush();
    const reply = legalMoves(afterHuman)[0]!;
    expect(game.history).toEqual(['c3-d4', formatMove(reply)]);

    const pending = board.update({});
    expect(board.status().state).toBe('pending-move');
    expect(pending.lcd[0]).toBe(`AI: ${formatMove(reply)}`.padEnd(16));
    const leds = ledsOf(pending);
    expect(leds[pending.leds.find((l) => l.led === ledIndex(reply.from))!.square]).toBe('FFB000/solid');

    const done = place(maskOf(applyMove(afterHuman, reply)));
    expect(board.status()).toMatchObject({ state: 'play', boardPly: 2 });
    expect(done.lcd[0]).toBe('Sinu kord: valge');
  });

  it('näitab viga alles siis, kui vale seis püsib', () => {
    startGame({ opponent: 'none' });
    const wrong = INITIAL & ~bit('c3') & ~bit('a3') | bit('d4');
    board.update({ mask: wrong });
    t += 200;
    expect(board.update({}).lcd[0]).not.toContain('Vale');
    t += 1000;
    const error = board.update({});
    expect(error.lcd[0]).toBe('Vale kaik!      ');
    expect(ledsOf(error)).toEqual({ a3: 'FF0000/blink', c3: 'FF0000/blink', d4: 'B000FF/blink' });
  });

  it('vilgutab nuppe, mis peavad lööma', () => {
    const game = startGame({ opponent: 'none' });
    for (const m of ['c3-d4', 'f6-e5']) store.play(game, findMove(game.position, m)!);
    board.attach(game);
    const display = place(maskOf(game.position));
    expect(display.lcd[1]).toBe('Loomine kohust. ');
    expect(ledsOf(display)).toEqual({ d4: 'FF6000/blink' });
  });

  it('B1 näitab vihjet', () => {
    startGame({ opponent: 'none' });
    const hint = press(1);
    expect(hint.lcd[0]).toMatch(/^Vihje: [a-h]\d-[a-h]\d/);
    expect(hint.leds).toHaveLength(2);
    t += 20_000;
    expect(board.update({}).lcd[0]).toBe('Valge kord      ');
  });

  it('B2 võtab käigu ja AI vastuse tagasi ning laud tuleb tagasi seada', async () => {
    const game = startGame({ opponent: 'claude' });
    const afterHuman = applyMove(initialPosition(), findMove(initialPosition(), 'c3-d4')!);
    place(maskOf(afterHuman));
    await flush();
    place(maskOf(game.position));
    expect(game.history).toHaveLength(2);

    const undo = press(2);
    expect(game.history).toEqual([]);
    expect(undo.lcd[0]).toBe('Sea nupud paika ');
    expect(Object.keys(ledsOf(undo)).length).toBeGreaterThan(0);
    place(INITIAL);
    expect(board.status()).toMatchObject({ state: 'play', boardPly: 0 });
  });

  it('menüüga saab valida vastase, värvi ja alustada uue mängu', async () => {
    expect(press(3).lcd[0]).toBe('>Uus mang       ');
    expect(press(1).lcd[0]).toBe('>Vastane:Claude ');
    expect(press(2).lcd[0]).toBe('>Vastane:arvuti ');
    press(1);
    expect(press(1).lcd[0]).toBe('>Sina:valge     ');
    expect(press(2).lcd[0]).toBe('>Sina:must      ');
    expect(press(1).lcd[0]).toBe('>Kell:valjas    ');
    expect(press(2).lcd[0]).toBe('>Kell:5 min     ');
    expect(press(1).lcd[0]).toBe('>Kordus         ');
    expect(press(1).lcd[0]).toBe('>Paku viiki     ');
    expect(press(1).lcd[0]).toBe('>Alistu         ');
    expect(press(1).lcd[0]).toBe('>Uus mang       ');
    press(2);
    const game = board.game!;
    expect(game).toMatchObject({ opponent: 'engine', humanColor: 'black', clock: { initialMs: 300_000 } });
    expect(board.status().state).toBe('waiting-board');
    place(INITIAL);
    await flush();
    expect(game.history).toHaveLength(1);
    expect(board.update({}).lcd[0]).toMatch(/^AI: /);
  });

  it('näitab, et AI mõtleb', () => {
    let resolve: (m: OpponentMove | null) => void = () => {};
    store = new GameStore({
      engine: createEngineOpponent(),
      claude: { kind: 'claude', chooseMove: () => new Promise((r) => (resolve = r)) },
    });
    board = new BoardController('laud1', store, { now: () => t, timing: { settleMs: 100, errorMs: 1000 } });
    const game = startGame({ opponent: 'claude' });
    const afterHuman = applyMove(initialPosition(), findMove(initialPosition(), 'c3-d4')!);
    const thinking = place(maskOf(afterHuman));
    expect(game.aiThinking).toBe(true);
    expect(thinking.lcd[0]).toBe('AI motleb...    ');
    expect(press(2).lcd).toEqual(['Oota hetk       ', 'AI motleb...    ']);
    resolve(null);
  });

  it('mängu lõpus näitab võitjat', () => {
    const game = startGame({ opponent: 'none' });
    game.position = setupPosition({ white: ['a1'], black: ['b2', 'c3'] });
    game.positions = [game.position];
    board.attach(game);
    const end = place(maskOf(game.position));
    expect(end.effect).toBe('win-black');
    expect(end.lcd[0]).toBe('Must voitis!    ');
  });

  it('näitab male kella ja lõpetab mängu, kui aeg saab otsa', () => {
    const game = startGame({ opponent: 'none', clockMinutes: 5 });
    expect(board.update({}).lcd[1]).toBe('V 5:00    M 5:00');
    const afterC3 = applyMove(initialPosition(), findMove(initialPosition(), 'c3-d4')!);
    place(maskOf(afterC3));
    expect(game.history).toEqual(['c3-d4']);
    t += 61_000;
    expect(board.update({}).lcd[1]).toBe('V 5:00    M 3:59');
    t += 5 * 60_000;
    const end = board.update({});
    expect(end.lcd).toEqual(['Valge voitis!   ', 'Aeg sai otsa    ']);
    expect(end.effect).toBe('win-white');
    expect(store.canHumanMove(game)).toBe(false);
  });

  it('annab teada, kui Claude ei vastanud ja käis varumootor', async () => {
    store = new GameStore({
      engine: createEngineOpponent(),
      claude: {
        kind: 'claude',
        async chooseMove(pos) {
          const move = legalMoves(pos)[0]!;
          return { move, notation: formatMove(move), source: 'engine', fallbackReason: 'AI API pole kättesaadav' };
        },
      },
    });
    board = new BoardController('laud1', store, { now: () => t, timing: { settleMs: 100, errorMs: 1000 } });
    startGame({ opponent: 'claude' });
    place(maskOf(applyMove(initialPosition(), findMove(initialPosition(), 'c3-d4')!)));
    await flush();
    expect(place(board.status().mask ? Number(board.status().mask) : 0).lcd).toEqual(['Claude ei vasta ', 'Kais arvuti     ']);
  });

  it('näitab, kas laud on võrgus', () => {
    expect(board.status()).toMatchObject({ online: false, lastSeenAt: null });
    board.update({ mask: INITIAL });
    expect(board.status().online).toBe(true);
    t += 10_000;
    expect(board.status().online).toBe(false);
  });

  it('kui käik võetakse äpis tagasi ja tehakse uus, seatakse laud uuesti', () => {
    const game = startGame({ opponent: 'none' });
    store.play(game, findMove(game.position, 'c3-d4')!);
    place(maskOf(game.position));
    expect(board.status()).toMatchObject({ state: 'play', boardPly: 1 });
    store.undo(game);
    store.play(game, findMove(game.position, 'c3-b4')!);
    const display = place(maskOf(applyMove(initialPosition(), findMove(initialPosition(), 'c3-d4')!)));
    expect(board.status().state).toBe('setup');
    expect(ledsOf(display)).toEqual({ b4: 'FF0000/blink', d4: 'B000FF/blink' });
    place(maskOf(game.position));
    expect(board.status()).toMatchObject({ state: 'play', boardPly: 1 });
  });

  /** Avab menüü ja liigub antud reale (0 = Uus mäng). */
  const menuTo = (row: number) => {
    press(3);
    for (let i = 0; i < row; i++) press(1);
    return board.update({});
  };

  it('menüüst saab alistuda', () => {
    const game = startGame({ opponent: 'engine', humanColor: 'white' });
    expect(menuTo(7).lcd[0]).toBe('>Alistu         ');
    const end = press(2);
    expect(store.result(game)).toEqual({ status: 'win', winner: 'black', reason: 'resign' });
    expect(end.lcd).toEqual(['Must voitis!    ', 'Alistumine      ']);
  });

  it('kahe inimese mängus on viik menüüst kohe kokkulepitud', () => {
    const game = startGame({ opponent: 'none' });
    expect(menuTo(6).lcd[0]).toBe('>Paku viiki     ');
    const end = press(2);
    expect(store.result(game)).toEqual({ status: 'draw', reason: 'agreement' });
    expect(end.lcd).toEqual(['Viik!           ', 'Kokkuleppel     ']);
    expect(end.effect).toBe('draw');
  });

  it('AI keeldub viigist, kui tal on parem seis, ja ilma mänguta ei saa alistuda', () => {
    const game = startGame({ opponent: 'engine', humanColor: 'white' });
    game.position = setupPosition({ white: ['a1'], blackKings: ['h8', 'f8', 'd8'] });
    game.positions = [game.position];
    board.attach(game);
    place(maskOf(game.position));
    menuTo(6);
    expect(press(2).lcd).toEqual(['Viik            ', 'Vastane keeldus ']);
    expect(store.result(game).status).toBe('ongoing');

    board = new BoardController('laud2', store, { now: () => t, timing: { settleMs: 100, errorMs: 1000 } });
    menuTo(7);
    expect(press(2).lcd[0]).toBe('Mang pole kaimas');
  });

  it('näitab viigi põhjust', () => {
    const game = startGame({ opponent: 'none' });
    game.position = { ...setupPosition({ whiteKings: ['a1', 'c1', 'e1'], blackKings: ['h8'] }), loneKingPlies: 30 };
    game.positions = [game.position];
    board.attach(game);
    expect(place(maskOf(game.position)).lcd).toEqual(['Viik!           ', '3 tammi vs 1    ']);
  });
});
