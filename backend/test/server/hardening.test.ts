import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createEngineOpponent, type Opponent } from '../../src/ai/opponent.js';
import { findMove, formatMove, legalMoves, positionKey, setupPosition } from '../../src/game/rules.js';
import { PlayerStore } from '../../src/players/store.js';
import { BUILTIN_PUZZLES, puzzleGame } from '../../src/puzzles/library.js';
import { Game } from '../../src/record/game.js';
import { gameFromPdn, parseFen, toFen, toPdn } from '../../src/record/pdn.js';
import { buildApp } from '../../src/server/app.js';
import { GameStore } from '../../src/server/games.js';

const engine = createEngineOpponent(() => 0);
const firstMove: Opponent = {
  kind: 'claude',
  async chooseMove(pos) {
    const move = legalMoves(pos)[0];
    return move ? { move, notation: formatMove(move), source: 'claude' } : null;
  },
};
const puzzle = BUILTIN_PUZZLES[0]!;

describe('canUndo', () => {
  const store = () => new GameStore({ engine, claude: engine });

  it('vastab sellele, mida undo tegelikult teeb', () => {
    const s = store();
    const game = s.create({ opponent: null, level: 'medium', humanColor: 'white' });
    expect(s.canUndo(game)).toBe(false);
    s.play(game, findMove(game.position, 'c3-d4')!);
    expect(s.canUndo(game)).toBe(true);
    s.resign(game, 'black');
    expect(s.canUndo(game)).toBe(false);
    expect(s.undo(game)).toBe(0);
  });

  it('ülesandes ei saa tagasi võtta', () => {
    const s = store();
    const game = s.create(puzzleGame(puzzle));
    s.play(game, findMove(game.position, puzzle.solution)!);
    expect(s.canUndo(game)).toBe(false);
    expect(s.undo(game)).toBe(0);
  });

  it('reitingumängus ei saa pärast tulemuse arvestamist tagasi võtta', () => {
    const s = store();
    const game = s.create({ opponent: null, level: 'medium', humanColor: 'white' });
    game.rated = true;
    s.play(game, findMove(game.position, 'c3-d4')!);
    expect(s.canUndo(game)).toBe(false);
    expect(s.undo(game)).toBe(0);
  });

  it('tagasivõtt tühistab viigipakkumise', () => {
    const s = store();
    const game = s.create({ opponent: null, level: 'medium', humanColor: 'white' });
    s.play(game, findMove(game.position, 'c3-d4')!);
    s.offerDraw(game, 'black');
    expect(game.drawOffer).toBe('black');
    expect(s.undo(game)).toBe(1);
    expect(game.drawOffer).toBeNull();
    // Vana pakkumist ei saa enam vastu võtta.
    expect(s.offerDraw(game, 'white')).toBe('pending');
  });
});

describe('FEN', () => {
  it('parseFen on toFen pöördfunktsioon', () => {
    const pos = setupPosition({ white: ['c3', 'e5'], whiteKings: ['a1'], black: ['f6'], blackKings: ['h8'], turn: 'black' });
    const fen = toFen(pos);
    expect(fen).toBe('B:WKa1,c3,e5:Bf6,Kh8');
    expect(positionKey(parseFen(fen))).toBe(positionKey(pos));
    expect(positionKey(parseFen(`${fen.toLowerCase()}.`))).toBe(positionKey(pos));
    expect(positionKey(parseFen('W:W:B'))).toBe(positionKey(setupPosition({})));
  });

  it('annab vigase FEN-i korral selge vea', () => {
    expect(() => parseFen('X:Wc3:Bf6')).toThrow(/W või B/);
    expect(() => parseFen('W:Qc3')).toThrow(/osa/);
    expect(() => parseFen('W:W21:B12')).toThrow(/ruut/);
    expect(() => parseFen('W:Wd4:Bc3')).not.toThrow();
    expect(() => parseFen('W:Wc4')).toThrow(/ruut/);
    expect(() => parseFen('W:Wc3:Bc3')).toThrow(/kaks korda/);
  });

  it('algseisuga mäng läbib PDN ekspordi ja impordi', () => {
    const start = setupPosition({ white: ['c3'], black: ['f6', 'h6'], turn: 'black' });
    const game = new Game({ start });
    game.play(findMove(start, 'f6-e5')!);
    game.play(findMove(game.position, 'c3-d4')!);
    const pdn = toPdn(game.toRecord());
    expect(pdn).toContain('[SetUp "1"]');
    const back = gameFromPdn(pdn);
    expect(back.toRecord().start).toBe(positionKey(start));
    expect(positionKey(back.position)).toBe(positionKey(game.position));
    expect(Game.fromRecord(back.toRecord()).moves.length).toBe(2);
  });

  it('vigane algseis salvestises annab vea', () => {
    const record = new Game().toRecord();
    expect(() => Game.fromRecord({ ...record, start: 'vigane' })).toThrow(/algseis/);
  });
});

describe('API pärast parandusi', () => {
  let app: FastifyInstance;
  afterEach(async () => app?.close());

  it('ülesande mängu serialiseering ütleb, et tagasivõtt pole võimalik', async () => {
    app = buildApp({ opponents: { engine, claude: firstMove } });
    const started = await app.inject({ method: 'POST', url: `/api/puzzles/${puzzle.id}/start`, payload: {} });
    const id = started.json().game.id as string;
    const moved = await app.inject({ method: 'POST', url: `/api/games/${id}/moves`, payload: { move: puzzle.solution } });
    expect(moved.statusCode).toBe(200);
    expect(moved.json().game.canUndo).toBe(false);
    const undo = await app.inject({ method: 'POST', url: `/api/games/${id}/undo`, payload: {} });
    expect(undo.statusCode).toBeGreaterThanOrEqual(400);
    expect(undo.statusCode).toBeLessThan(500);
  });

  it('eksporditud ülesande saab tagasi importida', async () => {
    app = buildApp({ opponents: { engine, claude: firstMove } });
    const started = await app.inject({ method: 'POST', url: `/api/puzzles/${puzzle.id}/start`, payload: {} });
    const id = started.json().game.id as string;
    await app.inject({ method: 'POST', url: `/api/games/${id}/moves`, payload: { move: puzzle.solution } });
    const pdn = (await app.inject({ method: 'GET', url: `/api/games/${id}/pdn` })).body;
    const imported = await app.inject({ method: 'POST', url: '/api/games/import', payload: { pdn } });
    expect(imported.statusCode).toBe(201);
    const original = (await app.inject({ method: 'GET', url: `/api/games/${id}` })).json().game;
    expect(imported.json().game.board).toEqual(original.board);
    expect(imported.json().game.moves).toEqual(original.moves);
  });

  it('mängijatega mängus pakub serialiseering õiget canUndo väärtust', async () => {
    const players = new PlayerStore();
    app = buildApp({ opponents: { engine, claude: firstMove }, players });
    const a = (await app.inject({ method: 'POST', url: '/api/players', payload: { name: 'A' } })).json().player;
    const b = (await app.inject({ method: 'POST', url: '/api/players', payload: { name: 'B' } })).json().player;
    const created = await app.inject({
      method: 'POST',
      url: '/api/games',
      payload: { opponent: 'none', players: { white: a.id, black: b.id } },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().game.id as string;
    const moved = await app.inject({ method: 'POST', url: `/api/games/${id}/moves`, payload: { move: 'c3-d4' } });
    expect(moved.json().game.canUndo).toBe(true);
    const resigned = await app.inject({ method: 'POST', url: `/api/games/${id}/resign`, payload: { color: 'black' } });
    expect(resigned.statusCode).toBe(200);
    expect(resigned.json().game.canUndo).toBe(false);
  });
});
