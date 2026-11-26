/**
 * Laua API. Laud (Arduino) küsib regulaarselt, näiteks 5 korda sekundis:
 *
 *   POST /api/board/:boardId/state  { mask: 0xfff00fff, buttons: [1] }
 *   → { lcd: ["Sinu kord: valge", "Valge 12 must 12"], leds: [...], effect: "none", seq: "…" }
 *
 * Äpp saab laua mänguga siduda ja laua olekut vaadata.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { GameStore } from '../server/games.js';
import { HttpError, parse } from '../server/http.js';
import type { PuzzleLibrary } from '../puzzles/library.js';
import { BoardController, type BoardControllerOptions } from './controller.js';

export type BoardTimingOptions = BoardControllerOptions;

/** Rohkem lauda ühe serveri külge ei lubata (kaitse vigaste id-de eest). */
export const MAX_BOARDS = 16;

const BoardParams = z.object({ boardId: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/, 'lubatud on tähed, numbrid, - ja _') });

const Mask = z.union([
  z.number().int().min(0).max(0xffffffff),
  z
    .string()
    .regex(/^(0x)?[0-9a-fA-F]{1,8}$/, 'peab olema kuueteistkümnendarv')
    .transform((s) => Number.parseInt(s.replace(/^0x/i, ''), 16)),
]);

const StateBody = z.object({
  /** 32-bitine hõivatusmask: bitt i = 1, kui ruudul i on nupp. */
  mask: Mask.optional(),
  /** Pärast eelmist päringut vajutatud nupud (1, 2 või 3). */
  buttons: z.array(z.union([z.literal(1), z.literal(2), z.literal(3)])).max(10).default([]),
});

const AttachBody = z.object({ gameId: z.string().min(1).max(64) });

const NewGameBody = z.object({
  opponent: z.enum(['engine', 'claude', 'none']).optional(),
  level: z.enum(['beginner', 'medium', 'strong']).optional(),
  humanColor: z.enum(['white', 'black']).optional(),
  clockMinutes: z.number().int().min(0).max(180).optional(),
  /** Edetabeli mängija laua taga, null = külaline. */
  playerId: z.string().min(1).max(64).nullable().optional(),
});

const PuzzleBody = z.object({ puzzleId: z.string().min(1).max(64) });

const BoardId = z.string().regex(/^[A-Za-z0-9_-]{1,32}$/, 'lubatud on tähed, numbrid, - ja _');
const MatchBody = z.object({
  white: BoardId,
  black: BoardId,
  clockMinutes: z.number().int().min(0).max(180).default(0),
});

export function registerBoardRoutes(
  app: FastifyInstance,
  store: GameStore,
  options: BoardControllerOptions = {},
  puzzles?: PuzzleLibrary,
): void {
  const boards = new Map<string, BoardController>();

  const board = (params: unknown): BoardController => {
    const { boardId } = parse(BoardParams, params);
    let controller = boards.get(boardId);
    if (!controller) {
      if (boards.size >= MAX_BOARDS) throw new HttpError(429, 'Liiga palju lauda');
      controller = new BoardController(boardId, store, options);
      boards.set(boardId, controller);
    }
    return controller;
  };

  const view = (controller: BoardController) => ({ board: controller.status(), display: controller.display() });

  /** Laua põhipäring: mask ja nupud sisse, ekraan ja LED-id välja. */
  app.post('/api/board/:boardId/state', async (req) => {
    const controller = board(req.params);
    const body = parse(StateBody, req.body);
    return controller.update({ mask: body.mask, buttons: body.buttons });
  });

  app.get('/api/board/:boardId', async (req) => view(board(req.params)));

  /** Seob laua äpis loodud mänguga. */
  app.post('/api/board/:boardId/attach', async (req) => {
    const controller = board(req.params);
    const { gameId } = parse(AttachBody, req.body);
    const game = await store.load(gameId);
    if (!game) throw new HttpError(404, 'Mängu ei leitud');
    controller.attach(game);
    return view(controller);
  });

  /** Mängib salvestatud mängu laual LED-idega läbi. */
  app.post('/api/board/:boardId/replay', async (req) => {
    const controller = board(req.params);
    const { gameId } = parse(AttachBody, req.body);
    const game = await store.load(gameId);
    if (!game) throw new HttpError(404, 'Mängu ei leitud');
    controller.startReplay(game);
    return view(controller);
  });

  /** Alustab laual kabeülesannet: LED-id näitavad, kuhu nupud panna. */
  app.post('/api/board/:boardId/puzzle', async (req, reply) => {
    const controller = board(req.params);
    const { puzzleId } = parse(PuzzleBody, req.body);
    const puzzle = puzzles?.get(puzzleId);
    if (!puzzle) throw new HttpError(404, 'Ülesannet ei leitud');
    controller.startPuzzle(puzzle);
    reply.status(201);
    return view(controller);
  });

  /**
   * Võrgumäng kahe laua vahel: mõlemad lauad seotakse sama mänguga, kumbki
   * oma värviga. Ühe laua käik süttib teisel LED-idega.
   */
  app.post('/api/matches', async (req, reply) => {
    const body = parse(MatchBody, req.body);
    if (body.white === body.black) throw new HttpError(400, 'Valge ja must peavad olema erinevad lauad');
    const white = board({ boardId: body.white });
    const black = board({ boardId: body.black });
    const game = store.create({ opponent: null, level: 'medium', humanColor: 'white', clockMs: body.clockMinutes * 60_000 });
    white.joinMatch(game, 'white', body.black, () => boards.get(body.black));
    black.joinMatch(game, 'black', body.white, () => boards.get(body.white));
    reply.status(201);
    return { gameId: game.id, boards: [white.status(), black.status()] };
  });

  /** Uus mäng laual (sama, mis menüüst "Uus mäng"). */
  app.post('/api/board/:boardId/games', async (req, reply) => {
    const controller = board(req.params);
    const body = parse(NewGameBody, req.body);
    controller.newGame(body);
    reply.status(201);
    return view(controller);
  });
}
