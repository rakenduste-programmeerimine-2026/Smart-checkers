/**
 * Mänguserveri REST API (Fastify).
 *
 * Mängud hoitakse praegu mälus (GameStore). Laua lõpp-punktid on failis board/routes.ts.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import { applyMove, findMove, formatMove, initialPosition, legalMoves } from '../game/rules.js';
import { squareName } from '../game/squares.js';
import type { GameResult, Position } from '../game/types.js';
import { suggestMove } from '../ai/engine.js';
import type { Opponent, OpponentKind, OpponentMove } from '../ai/opponent.js';
import { registerBoardRoutes, type BoardTimingOptions } from '../board/routes.js';
import { toPdn } from '../record/pdn.js';
import type { GameStore as RecordStore } from '../record/store.js';
import { GameStore, type Game } from './games.js';
import { HttpError, parse } from './http.js';
import { registerSecurity, type SecurityOptions } from './security.js';

export type { Game } from './games.js';

export interface AppOptions {
  opponents: Record<OpponentKind, Opponent>;
  logger?: boolean;
  /** Laua ajastused (testides lühemad) ja kell. */
  board?: BoardTimingOptions;
  /** Kuhu mängud salvestada (vaikimisi ainult mälus). */
  records?: RecordStore;
  /** Mitu mängu mälus hoida. */
  maxGames?: number;
  /** Ligipääsuvõtmed ja päringulimiit. */
  security?: SecurityOptions;
  /** Kas usaldada X-Forwarded-For päist (server on pöördproksi taga). */
  trustProxy?: boolean;
}

/** Suurim lubatud päringu keha (PDN-i import on kuni 100 000 märki). */
export const BODY_LIMIT = 256 * 1024;

const Level = z.enum(['beginner', 'medium', 'strong']);
const OpponentSchema = z.enum(['engine', 'claude', 'none']);

const CreateGameBody = z.object({
  opponent: OpponentSchema.default('claude'),
  level: Level.default('medium'),
  humanColor: z.enum(['white', 'black']).default('white'),
  /** Male kell minutites kummalegi poolele, 0 = kellata. */
  clockMinutes: z.number().int().min(0).max(180).default(0),
});

const ListQuery = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) });

const ImportBody = z.object({ pdn: z.string().min(1).max(100_000) });

const MoveBody = z.object({ move: z.string().min(4).max(64) });

const AiMoveBody = z.object({
  /** Käigud algseisust alates, näiteks ["c3-d4", "f6-e5"]. */
  moves: z.array(z.string().min(4).max(64)).max(500).default([]),
  opponent: z.enum(['engine', 'claude']).default('claude'),
  level: Level.default('medium'),
});

function replay(moves: string[]): { position: Position; history: string[] } {
  let position = initialPosition();
  const history: string[] = [];
  for (const [i, text] of moves.entries()) {
    const move = findMove(position, text);
    if (!move) throw new HttpError(400, `Käik ${i + 1} ("${text}") pole selles seisus seaduslik`);
    position = applyMove(position, move);
    history.push(formatMove(move));
  }
  return { position, history };
}

export function serializePosition(position: Position) {
  return {
    turn: position.turn,
    pieces: position.board.flatMap((piece, sq) =>
      piece ? [{ square: squareName(sq), color: piece.color, king: piece.king }] : [],
    ),
    legalMoves: legalMoves(position).map(formatMove),
  };
}

export function serializeGame(game: Game, store: GameStore) {
  const result: GameResult = store.result(game);
  const clock = game.clock
    ? {
        initialMs: game.clock.initialMs,
        white: store.remaining(game, 'white'),
        black: store.remaining(game, 'black'),
        running: game.clock.runningSince !== null && result.status === 'ongoing' ? game.position.turn : null,
      }
    : null;
  const moveTimes = game.moveTimes;
  return {
    id: game.id,
    opponent: game.opponent ?? 'none',
    level: game.level,
    humanColor: game.humanColor,
    createdAt: game.createdAt,
    history: game.history,
    moveTimes,
    clock,
    aiThinking: game.aiThinking,
    result,
    ...serializePosition(game.position),
  };
}

export function serializeAiMove(m: OpponentMove | null) {
  if (!m) return null;
  return {
    move: m.notation,
    from: squareName(m.move.from),
    path: m.move.path.map(squareName),
    captures: m.move.captures.map(squareName),
    promotes: m.move.promotes,
    source: m.source,
    reason: m.reason ?? null,
    fallbackReason: m.fallbackReason ?? null,
  };
}

export function buildApp(options: AppOptions): FastifyInstance {
  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: BODY_LIMIT,
    maxParamLength: 128,
    requestTimeout: 60_000,
    trustProxy: options.trustProxy ?? false,
  });
  registerSecurity(app, options.security);
  const store = new GameStore(options.opponents, (error) => app.log.error({ err: error }, 'Mängu viga'), {
    records: options.records,
    maxGames: options.maxGames,
  });
  app.addHook('onClose', async () => store.flush());

  app.setErrorHandler((error: Error & { statusCode?: number }, req, reply) => {
    const status = error instanceof HttpError ? error.statusCode : (error.statusCode ?? 500);
    if (status >= 500) req.log.error({ err: error }, 'Serveri viga');
    const message =
      status >= 500 ? 'Serveri viga' : status === 413 ? 'Päring on liiga suur' : error.message;
    reply.status(status).send({ error: message });
  });

  app.setNotFoundHandler((_req, reply) => {
    reply.status(404).send({ error: 'Sellist teed pole' });
  });

  const getGame = async (id: string): Promise<Game> => {
    const game = await store.load(id);
    if (!game) throw new HttpError(404, 'Mängu ei leitud');
    return game;
  };

  app.get('/health', async () => ({ status: 'ok' }));

  app.post('/api/games', async (req, reply) => {
    const body = parse(CreateGameBody, req.body);
    const game = store.create({
      opponent: body.opponent === 'none' ? null : body.opponent,
      level: body.level,
      humanColor: body.humanColor,
      clockMs: body.clockMinutes * 60_000,
    });
    // Kui inimene on must, alustab AI.
    const aiMove = await store.aiTurn(game);
    reply.status(201);
    return { game: serializeGame(game, store), aiMove: serializeAiMove(aiMove) };
  });

  app.get('/api/games', async (req) => {
    const { limit } = parse(ListQuery, req.query);
    return { games: await store.list(limit) };
  });

  /** Impordib PDN-faili (näiteks teisest kabeprogrammist) kahe inimese mänguks. */
  app.post('/api/games/import', async (req, reply) => {
    const { pdn } = parse(ImportBody, req.body);
    let game: Game;
    try {
      game = store.importPdn(pdn);
    } catch (error) {
      throw new HttpError(422, `PDN-i ei saanud lugeda: ${(error as Error).message}`);
    }
    reply.status(201);
    return { game: serializeGame(game, store) };
  });

  app.get<{ Params: { id: string } }>('/api/games/:id', async (req) => ({ game: serializeGame(await getGame(req.params.id), store) }));

  app.get<{ Params: { id: string } }>('/api/games/:id/pdn', async (req, reply) => {
    const game = await getGame(req.params.id);
    reply
      .type('application/x-pdn; charset=utf-8')
      .header('content-disposition', `attachment; filename="kabe-${game.id.slice(0, 8)}.pdn"`);
    return toPdn(store.toRecord(game));
  });

  app.delete<{ Params: { id: string } }>('/api/games/:id', async (req, reply) => {
    if (!(await store.delete(req.params.id))) throw new HttpError(404, 'Mängu ei leitud');
    reply.status(204);
    return null;
  });

  app.post<{ Params: { id: string } }>('/api/games/:id/moves', async (req) => {
    const game = await getGame(req.params.id);
    const { move: text } = parse(MoveBody, req.body);
    if (store.isOver(game)) throw new HttpError(409, 'Mäng on juba läbi');
    if (!store.canHumanMove(game)) throw new HttpError(409, 'Praegu on AI kord');
    const move = findMove(game.position, text);
    if (!move) throw new HttpError(422, `Käik "${text}" pole seaduslik või pole üheselt mõistetav`);
    store.play(game, move);
    const aiMove = await store.aiTurn(game);
    return { game: serializeGame(game, store), aiMove: serializeAiMove(aiMove) };
  });

  app.post<{ Params: { id: string } }>('/api/games/:id/undo', async (req) => {
    const game = await getGame(req.params.id);
    if (game.aiThinking) throw new HttpError(409, 'AI mõtleb, oota hetk');
    const undone = store.undo(game);
    if (undone === 0) throw new HttpError(409, 'Pole käiku, mida tagasi võtta');
    return { game: serializeGame(game, store), undone };
  });

  app.post<{ Params: { id: string } }>('/api/games/:id/hint', async (req) => {
    const game = await getGame(req.params.id);
    const hint = suggestMove(game.position);
    return { hint: hint ? formatMove(hint.move) : null };
  });

  /** Olekuta AI käik: äpp saadab käigud algusest ja saab vastukäigu. */
  app.post('/api/ai/move', async (req) => {
    const body = parse(AiMoveBody, req.body);
    const { position } = replay(body.moves);
    const choice = await options.opponents[body.opponent].chooseMove(position, body.level);
    return { position: serializePosition(position), aiMove: serializeAiMove(choice) };
  });

  registerBoardRoutes(app, store, options.board);

  return app;
}
