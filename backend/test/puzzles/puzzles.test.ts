import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createEngineOpponent } from '../../src/ai/opponent.js';
import { searchMoves } from '../../src/ai/engine.js';
import { BoardController } from '../../src/board/controller.js';
import { applyMove, findMove, formatMove, initialPosition, legalMoves, parsePositionKey, positionKey, setupPosition } from '../../src/game/rules.js';
import { occupancyMask } from '../../src/game/sensors.js';
import { BUILTIN_PUZZLES, MAX_CUSTOM_PUZZLES, PuzzleLibrary, puzzleGame, type PuzzleDef } from '../../src/puzzles/library.js';
import { toFen, toPdn } from '../../src/record/pdn.js';
import { buildApp } from '../../src/server/app.js';
import { GameStore } from '../../src/server/games.js';
import type { GameReview } from '../../src/analysis/review.js';

const engine = createEngineOpponent(() => 0);
const puzzle = BUILTIN_PUZZLES[0]!;
const wrongMove = (p: PuzzleDef) => legalMoves(p.position).map(formatMove).find((m) => m !== p.solution)!;

describe('seisu tekstikuju', () => {
  it('positionKey ja parsePositionKey on teineteise pöördfunktsioonid', () => {
    const pos = setupPosition({ white: ['c3'], whiteKings: ['a1'], blackKings: ['h8'], black: ['f6'], turn: 'black' });
    expect(positionKey(parsePositionKey(positionKey(pos))!)).toBe(positionKey(pos));
    expect(parsePositionKey('x')).toBeNull();
    expect(parsePositionKey(`w${'.'.repeat(31)}`)).toBeNull();
  });

  it('FEN', () => {
    const pos = setupPosition({ white: ['c3'], whiteKings: ['a1'], black: ['h8'], turn: 'black' });
    expect(toFen(pos)).toBe('B:WKa1,c3:Bh8');
  });
});

describe('sisseehitatud ülesanded', () => {
  it('on unikaalsete id-dega ja lahendus on seaduslik', () => {
    expect(new Set(BUILTIN_PUZZLES.map((p) => p.id)).size).toBe(BUILTIN_PUZZLES.length);
    expect(BUILTIN_PUZZLES.length).toBeGreaterThanOrEqual(10);
    for (const p of BUILTIN_PUZZLES) {
      expect(findMove(p.position, p.solution), p.id).not.toBeNull();
      expect(legalMoves(p.position).length, p.id).toBeGreaterThan(1);
    }
  });

  it('lahendus on mootori järgi selgelt parem kui teised käigud', { timeout: 120_000 }, () => {
    for (const p of BUILTIN_PUZZLES) {
      const { choices } = searchMoves(p.position, 'strong', { timeMs: 60_000 });
      const solution = choices.find((c) => formatMove(c.move) === p.solution)!;
      const others = choices.filter((c) => c !== solution);
      expect(solution.score, p.id).toBeGreaterThanOrEqual(Math.max(...others.map((c) => c.score)) + 100);
    }
  });
});

describe('ülesanne mängus', () => {
  it('õige käik lahendab ülesande ja seda ei saa tagasi võtta', () => {
    const store = new GameStore({ engine, claude: engine });
    const game = store.create(puzzleGame(puzzle));
    expect(game.humanColor).toBe(puzzle.position.turn);
    expect(store.result(game).status).toBe('ongoing');
    store.play(game, findMove(game.position, puzzle.solution)!);
    expect(game.puzzle).toMatchObject({ state: 'solved', found: 1, solution: null });
    expect(store.result(game)).toEqual({ status: 'win', winner: game.humanColor, reason: 'puzzle' });
    expect(store.undo(game)).toBe(0);
  });

  it('vale käik näitab lahendust ja arvuti võidab', () => {
    const store = new GameStore({ engine, claude: engine });
    const game = store.create(puzzleGame(puzzle));
    store.play(game, findMove(game.position, wrongMove(puzzle))!);
    expect(game.puzzle).toMatchObject({ state: 'failed', solution: puzzle.solution });
    expect(store.result(game)).toMatchObject({ status: 'win', reason: 'puzzle' });
    expect(store.isAiTurn(game)).toBe(false);
  });

  it('ilma teadaoleva lahenduseta otsustab mootor', () => {
    const store = new GameStore({ engine, claude: engine });
    const game = store.create({ ...puzzleGame(puzzle), puzzle: { id: 'x', title: 'x', goalMoves: 2 } });
    store.play(game, findMove(game.position, puzzle.solution)!);
    expect(game.puzzle).toMatchObject({ state: 'solving', found: 1 });
    // Vastase käik ei loe; järgmine inimese käik kontrollitakse uuesti.
    const reply = legalMoves(game.position)[0]!;
    store.play(game, reply);
    expect(game.puzzle!.found).toBe(1);
  });

  it('salvestatakse algseisu ja olekuga ning taastatakse', () => {
    const store = new GameStore({ engine, claude: engine });
    const game = store.create(puzzleGame(puzzle));
    store.play(game, findMove(game.position, puzzle.solution)!);
    const record = store.toRecord(game);
    expect(record.start).toBe(positionKey(puzzle.position));
    expect(record.puzzle).toMatchObject({ id: puzzle.id, state: 'solved' });
    const restored = new GameStore({ engine, claude: engine }).restore(record);
    expect(positionKey(restored.position)).toBe(positionKey(game.position));
    expect(restored.puzzle?.state).toBe('solved');
    const pdn = toPdn(record);
    expect(pdn).toContain('[SetUp "1"]');
    expect(pdn).toContain(`[FEN "${toFen(puzzle.position)}"]`);
    if (puzzle.position.turn === 'black') expect(pdn).toContain(`1... ${puzzle.solution}`);
    expect(() => new GameStore({ engine, claude: engine }).restore({ ...record, start: 'vigane' })).toThrow(/algseis/);
    // Tavalisel mängul algseisu ei salvestata.
    expect(store.toRecord(store.create({ opponent: null, level: 'medium', humanColor: 'white' })).start).toBeUndefined();
  });

  it('valge algusega ülesande PDN-i numeratsioon', () => {
    const white = BUILTIN_PUZZLES.find((p) => p.position.turn === 'white')!;
    const store = new GameStore({ engine, claude: engine });
    const game = store.create(puzzleGame(white));
    store.play(game, findMove(game.position, white.solution)!);
    expect(toPdn(store.toRecord(game))).toContain(`1. ${white.solution}`);
  });
});

describe('PuzzleLibrary', () => {
  const review = (keyMoments: number[]): GameReview => ({
    moves: keyMoments.map((ply) => ({
      ply,
      color: 'white',
      move: 'c3-d4',
      best: 'c3-b4',
      loss: 300,
      score: 0,
      classification: ply % 2 ? 'mistake' : 'blunder',
    })),
    summary: {
      white: { accuracy: 0, inaccuracies: 0, mistakes: 0, blunders: 0 },
      black: { accuracy: 0, inaccuracies: 0, mistakes: 0, blunders: 0 },
    },
    keyMoments,
  });

  it('järgmine ülesanne käib ringiga', () => {
    const lib = new PuzzleLibrary();
    expect(lib.next(null)?.id).toBe(BUILTIN_PUZZLES[0]!.id);
    expect(lib.next(BUILTIN_PUZZLES[0]!.id)?.id).toBe(BUILTIN_PUZZLES[1]!.id);
    expect(lib.next(BUILTIN_PUZZLES[BUILTIN_PUZZLES.length - 1]!.id)?.id).toBe(BUILTIN_PUZZLES[0]!.id);
    expect(new PuzzleLibrary([]).next(null)).toBeUndefined();
  });

  it('teeb mängu vigadest ülesanded ilma topeltideta ja piiranguga', () => {
    const lib = new PuzzleLibrary([]);
    const positions = [initialPosition()];
    // review.moves on indekseeritud ply järgi.
    const r: GameReview = { ...review([0]), moves: review([0]).moves };
    const made = lib.fromReview('abcdefgh-1234', positions, r);
    expect(made).toHaveLength(1);
    expect(made[0]).toMatchObject({ id: 'abcdefgh-0', solution: 'c3-b4', difficulty: 'easy', source: { kind: 'game', ply: 0 } });
    expect(lib.fromReview('abcdefgh-1234', positions, r)[0]).toBe(made[0]);
    expect(lib.get('abcdefgh-0')).toBe(made[0]);
    // Puuduv seis jäetakse vahele.
    expect(lib.fromReview('x', [], r)).toEqual([]);
    for (let i = 0; i < MAX_CUSTOM_PUZZLES + 3; i++) lib.fromReview(`g${i}`, positions, r);
    expect(lib.list()).toHaveLength(MAX_CUSTOM_PUZZLES);
    expect(lib.get('abcdefgh-0')).toBeUndefined();
  });
});

describe('ülesannete API', () => {
  let app: FastifyInstance;
  afterEach(async () => app?.close());

  it('nimekiri, ülesanne ja lahendamine', async () => {
    app = buildApp({ opponents: { engine, claude: engine } });
    const list = (await app.inject({ method: 'GET', url: '/api/puzzles' })).json().puzzles;
    expect(list).toHaveLength(BUILTIN_PUZZLES.length);
    expect(list[0]).not.toHaveProperty('solution');
    const one = (await app.inject({ method: 'GET', url: `/api/puzzles/${puzzle.id}` })).json().puzzle;
    expect(one).toMatchObject({ id: puzzle.id, turn: puzzle.position.turn });
    expect(one).not.toHaveProperty('solution');
    expect((await app.inject({ method: 'GET', url: '/api/puzzles/puudub' })).statusCode).toBe(404);

    const started = await app.inject({ method: 'POST', url: `/api/puzzles/${puzzle.id}/start`, payload: {} });
    expect(started.statusCode).toBe(201);
    const game = started.json().game;
    expect(game.puzzle).toMatchObject({ state: 'solving', solution: null });
    const solved = await app.inject({ method: 'POST', url: `/api/games/${game.id}/moves`, payload: { move: puzzle.solution } });
    expect(solved.json()).toMatchObject({ game: { puzzle: { state: 'solved' }, result: { reason: 'puzzle' } }, aiMove: null });
    expect((await app.inject({ method: 'POST', url: `/api/puzzles/${puzzle.id}/start`, payload: { playerId: 'x' } })).statusCode).toBe(404);
  });

  it('teeb mängu vigadest ülesanded', async () => {
    app = buildApp({ opponents: { engine, claude: engine } });
    const id = (await app.inject({ method: 'POST', url: '/api/games', payload: { opponent: 'none' } })).json().game.id;
    await app.inject({ method: 'POST', url: `/api/games/${id}/moves`, payload: { move: 'c3-d4' } });
    const res = await app.inject({ method: 'POST', url: `/api/games/${id}/puzzles` });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json().puzzles)).toBe(true);
  });
});

describe('ülesanne laual', () => {
  const setup = (lib = new PuzzleLibrary()) => {
    const store = new GameStore({ engine, claude: engine });
    let t = 0;
    const board = new BoardController('laud1', store, { now: () => t, timing: { settleMs: 100, errorMs: 1000, messageMs: 100 }, puzzles: lib });
    const place = (mask: number) => {
      board.update({ mask });
      t += 200;
      return board.update({});
    };
    return { store, board, place };
  };

  it('menüüst alustatud ülesande lahendamine', () => {
    const { board, place } = setup();
    board.update({ buttons: [3] });
    for (let i = 0; i < 6; i++) board.update({ buttons: [1] });
    expect(board.update({}).lcd[0]).toBe('>Ulesanne       ');
    board.update({ buttons: [2] });
    const game = board.game!;
    expect(game.puzzle?.id).toBe(puzzle.id);
    expect(place(occupancyMask(puzzle.position.board)).lcd).toEqual([
      `Ulesanne: ${puzzle.position.turn === 'white' ? 'valge ' : 'must  '}`.padEnd(16).slice(0, 16),
      'Leia parim kaik ',
    ]);
    expect(board.update({ buttons: [1] }).lcd).toEqual(['Ulesandes       ', 'vihjet pole     ']);
    const after = applyMove(puzzle.position, findMove(puzzle.position, puzzle.solution)!);
    const done = place(occupancyMask(after.board));
    expect(done.lcd[0]).toBe('Lahendatud!     ');
    expect(done.effect).toBe(`win-${puzzle.position.turn}`);
    // Järgmine ülesanne menüüst.
    board.update({ buttons: [3] });
    for (let i = 0; i < 6; i++) board.update({ buttons: [1] });
    board.update({ buttons: [2] });
    expect(board.game!.puzzle?.id).toBe(BUILTIN_PUZZLES[1]!.id);
  });

  it('vale käik laual näitab õiget', () => {
    const { board, place } = setup();
    board.startPuzzle(puzzle);
    place(occupancyMask(puzzle.position.board));
    const after = applyMove(puzzle.position, findMove(puzzle.position, wrongMove(puzzle))!);
    const shown = place(occupancyMask(after.board));
    expect(shown.lcd[0]).toBe('Vale kaik!      ');
    expect(shown.lcd[1]).toContain(puzzle.solution);
    expect(shown.leds.length).toBe(2);
  });

  it('ilma ülesanneteta annab teada', () => {
    const { board } = setup(new PuzzleLibrary([]));
    board.update({ buttons: [3] });
    for (let i = 0; i < 6; i++) board.update({ buttons: [1] });
    expect(board.update({ buttons: [2] }).lcd).toEqual(['Ulesandeid      ', 'pole            ']);
  });

  it('laua API alustab ülesannet', async () => {
    const app = buildApp({ opponents: { engine, claude: engine } });
    const res = await app.inject({ method: 'POST', url: '/api/board/laud1/puzzle', payload: { puzzleId: puzzle.id } });
    expect(res.statusCode).toBe(201);
    expect(res.json().board).toMatchObject({ state: 'waiting-board' });
    expect((await app.inject({ method: 'POST', url: '/api/board/laud1/puzzle', payload: { puzzleId: 'x' } })).statusCode).toBe(404);
    await app.close();
  });
});
