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
  store = new GameStore({ engine: createEngineOpponent(() => 0), claude: firstMove });
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
    press(1);
    press(2);
    const game = board.game!;
    expect(game).toMatchObject({ opponent: 'engine', humanColor: 'black' });
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
});
