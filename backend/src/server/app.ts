/**
 * Mänguserveri REST API (Fastify).
 *
 * Mängud hoitakse praegu mälus (GameStore). Laua lõpp-punktid on failis board/routes.ts.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import { applyMove, findMove, formatMove, initialPosition, legalMoves } from '../game/rules.js';
import { squareName } from '../game/squares.js';
import type { GameResult, Move, Position } from '../game/types.js';
import { KING_VALUE, MAN_VALUE, searchMoves, suggestMove } from '../ai/engine.js';
import type { Opponent, OpponentKind, OpponentMove } from '../ai/opponent.js';
import { registerBoardRoutes, type BoardTimingOptions } from '../board/routes.js';
import { toPdn } from '../record/pdn.js';
import { ratedResults } from '../players/rating.js';
import { registerPlayerRoutes } from '../players/routes.js';
import { PlayerStore } from '../players/store.js';
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
  /** Mängijad ja edetabel (vaikimisi ainult mälus). */
  players?: PlayerStore;
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
  /** Edetabeli mängijad: arvuti vastu ainult inimese värv. */
  players: z
    .object({ white: z.string().min(1).max(64).optional(), black: z.string().min(1).max(64).optional() })
    .optional(),
});

const ListQuery = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) });

const ImportBody = z.object({ pdn: z.string().min(1).max(100_000) });

/**
 * expectedPly = mitu käiku oli mängus äpi teada enne seda päringut. Kui see on
 * antud, on päring ohutu korrata: sama käigu kordus ei tee midagi topelt ja
 * vananenud seisust tehtud päring saab vastuseks 409.
 */
const MoveBody = z.object({ move: z.string().min(4).max(64), expectedPly: z.number().int().min(0).optional() });

const UndoBody = z.object({ expectedPly: z.number().int().min(0).optional() }).default({});

const ColorSchema = z.enum(['white', 'black']);

/** Kahe inimese mängus võib öelda, kes alistub või viiki pakub; vaikimisi käigul olev pool. */
const ResignBody = z.object({ color: ColorSchema.optional() }).default({});

const DrawBody = z.object({ action: z.enum(['offer', 'decline']).default('offer'), color: ColorSchema.optional() }).default({});

const AnalysisQuery = z.object({
  level: Level.default('medium'),
  top: z.coerce.number().int().min(1).max(10).default(3),
});

/** Analüüsi ja vihje mõtlemisaeg (ms). */
export const ANALYSIS_TIME_MS = 700;

/** SSE ühenduse elushoidmise intervall. */
export const SSE_HEARTBEAT_MS = 15_000;

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

function serializeMove(move: Move) {
  return {
    move: formatMove(move),
    from: squareName(move.from),
    path: move.path.map(squareName),
    captures: move.captures.map(squareName),
    promotes: move.promotes,
  };
}

/** Mängija nimi ja reiting mängu vaates (players on valikuline, et vana kood töötaks). */
function playerView(id: string | null, players?: PlayerStore) {
  if (!id) return null;
  const p = players?.peek(id);
  return p ? { id, name: p.name, rating: p.rating } : { id, name: null, rating: null };
}

export function serializeGame(game: Game, store: GameStore, players?: PlayerStore) {
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
  const lastMove = game.moves[game.moves.length - 1];
  return {
    id: game.id,
    opponent: game.opponent ?? 'none',
    level: game.level,
    humanColor: game.humanColor,
    createdAt: game.createdAt,
    history: game.history,
    moveTimes,
    clock,
    /** Käikude arv; saada see tagasi `expectedPly`-na, et kordused oleksid ohutud. */
    ply: game.history.length,
    lastMove: lastMove ? serializeMove(lastMove) : null,
    aiThinking: game.aiThinking,
    drawOffer: game.drawOffer,
    players: { white: playerView(game.players.white, players), black: playerView(game.players.black, players) },
    canUndo: !game.ending && !game.aiThinking && game.history.length > 0,
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

/** Seisu analüüs: hinnang (valge vaatenurgast, sentinuppudes) ja parimad käigud. */
export function analyse(position: Position, level: 'beginner' | 'medium' | 'strong', top: number) {
  const { choices, depth } = searchMoves(position, level, { timeMs: ANALYSIS_TIME_MS });
  const sign = position.turn === 'white' ? 1 : -1;
  const best = choices[0];
  const score = best ? sign * best.score : sign * -100_000;
  return {
    turn: position.turn,
    /** Positiivne = valgel parem. 100 = üks lihtnupp. */
    score,
    depth,
    /** Lühike eestikeelne kokkuvõte, mida äpp saab otse näidata. */
    summary: describeScore(score),
    bestMoves: choices.slice(0, top).map((c) => ({ ...serializeMove(c.move), score: sign * c.score })),
  };
}

function describeScore(score: number): string {
  if (Math.abs(score) > 50_000) return score > 0 ? 'Valge võidab' : 'Must võidab';
  const abs = Math.abs(score);
  const side = score > 0 ? 'valgel' : 'mustal';
  if (abs < 40) return 'Seis on võrdne';
  if (abs < MAN_VALUE) return `Väike eelis ${side}`;
  if (abs < KING_VALUE) return `Selge eelis ${side}`;
  return `Suur eelis ${side}`;
}

/** Äpi seis on vananenud: vastus sisaldab praegust mängu, et äpp saaks järele jõuda. */
class StaleError extends HttpError {
  constructor(readonly game: Game) {
    super(409, 'Mängu seis on vahepeal muutunud, värskenda');
  }
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
  const players = options.players ?? new PlayerStore();
  app.addHook('onReady', async () => players.ready());
  const store = new GameStore(options.opponents, (error) => app.log.error({ err: error }, 'Mängu viga'), {
    records: options.records,
    maxGames: options.maxGames,
    onGameOver: (game, result) => players.record(ratedResults(game, result, players, new Date().toISOString())),
  });
  /** Avatud SSE ühendused, mis serveri sulgemisel lõpetatakse. */
  const streams = new Set<() => void>();
  // preClose: enne kui server ootab ühenduste sulgumist.
  app.addHook('preClose', async () => {
    for (const end of streams) end();
    streams.clear();
  });
  app.addHook('onClose', async () => store.flush());

  app.setErrorHandler((error: Error & { statusCode?: number }, req, reply) => {
    const status = error instanceof HttpError ? error.statusCode : (error.statusCode ?? 500);
    if (status >= 500) req.log.error({ err: error }, 'Serveri viga');
    const message =
      status >= 500 ? 'Serveri viga' : status === 413 ? 'Päring on liiga suur' : error.message;
    if (error instanceof StaleError) {
      reply.status(409).send({ error: message, stale: true, game: serializeGame(error.game, store, players) });
      return;
    }
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

  const startedAt = Date.now();
  app.get('/health', async () => ({ status: 'ok', uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000) }));

  app.post('/api/games', async (req, reply) => {
    const body = parse(CreateGameBody, req.body);
    const opponent = body.opponent === 'none' ? null : body.opponent;
    const chosen = { white: body.players?.white ?? null, black: body.players?.black ?? null };
    if (opponent) chosen[body.humanColor === 'white' ? 'black' : 'white'] = null;
    for (const id of [chosen.white, chosen.black]) {
      if (id && !(await players.get(id))) throw new HttpError(404, 'Mängijat ei leitud');
    }
    if (chosen.white && chosen.white === chosen.black) throw new HttpError(400, 'Sama mängija ei saa mängida mõlema poolega');
    const game = store.create({
      opponent,
      level: body.level,
      humanColor: body.humanColor,
      clockMs: body.clockMinutes * 60_000,
      players: chosen,
    });
    // Kui inimene on must, alustab AI.
    const aiMove = await store.aiTurn(game);
    reply.status(201);
    return { game: serializeGame(game, store, players), aiMove: serializeAiMove(aiMove) };
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
    return { game: serializeGame(game, store, players) };
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
    const { move: text, expectedPly } = parse(MoveBody, req.body);
    if (expectedPly !== undefined && expectedPly !== game.history.length) {
      // Kordus: sama käik on juba tehtud (näiteks vastus läks võrgus kaduma).
      const before = game.positions[expectedPly];
      const previous = before ? findMove(before, text) : null;
      if (previous && game.history[expectedPly] === formatMove(previous)) {
        return { game: serializeGame(game, store, players), aiMove: serializeAiMove(game.lastAiMove), duplicate: true };
      }
      throw new StaleError(game);
    }
    if (store.isOver(game)) throw new HttpError(409, 'Mäng on juba läbi');
    if (!store.canHumanMove(game)) throw new HttpError(409, 'Praegu on AI kord');
    const move = findMove(game.position, text);
    if (!move) throw new HttpError(422, `Käik "${text}" pole seaduslik või pole üheselt mõistetav`);
    store.play(game, move);
    const aiMove = await store.aiTurn(game);
    return { game: serializeGame(game, store, players), aiMove: serializeAiMove(aiMove) };
  });

  app.post<{ Params: { id: string } }>('/api/games/:id/undo', async (req) => {
    const game = await getGame(req.params.id);
    const { expectedPly } = parse(UndoBody, req.body ?? {});
    if (expectedPly !== undefined && expectedPly !== game.history.length) throw new StaleError(game);
    if (game.aiThinking) throw new HttpError(409, 'AI mõtleb, oota hetk');
    if (game.ending) throw new HttpError(409, 'Mäng on läbi');
    const undone = store.undo(game);
    if (undone === 0) throw new HttpError(409, 'Pole käiku, mida tagasi võtta');
    return { game: serializeGame(game, store, players), undone };
  });

  app.post<{ Params: { id: string } }>('/api/games/:id/hint', async (req) => {
    const game = await getGame(req.params.id);
    if (store.isOver(game)) return { hint: null, detail: null };
    const hint = suggestMove(game.position);
    return { hint: hint ? formatMove(hint.move) : null, detail: hint ? serializeMove(hint.move) : null };
  });

  /** Alistumine. Arvuti vastu alistub alati inimene. */
  app.post<{ Params: { id: string } }>('/api/games/:id/resign', async (req) => {
    const game = await getGame(req.params.id);
    const { color } = parse(ResignBody, req.body ?? {});
    if (!store.resign(game, store.actor(game, color))) throw new HttpError(409, 'Mäng on juba läbi');
    return { game: serializeGame(game, store, players) };
  });

  /**
   * Viigipakkumine või -tagasilükkamine. Arvuti vastu vastab AI kohe
   * (status accepted/declined); kahe inimese mängus jääb pakkumine ootele.
   */
  app.post<{ Params: { id: string } }>('/api/games/:id/draw', async (req) => {
    const game = await getGame(req.params.id);
    const { action, color } = parse(DrawBody, req.body ?? {});
    const actor = store.actor(game, color);
    if (action === 'decline') {
      if (!store.declineDraw(game, actor)) throw new HttpError(409, 'Viigipakkumist pole');
      return { status: 'declined', game: serializeGame(game, store, players) };
    }
    const status = store.offerDraw(game, actor);
    if (status === 'over') throw new HttpError(409, 'Mäng on juba läbi');
    return { status, game: serializeGame(game, store, players) };
  });

  /**
   * Mänguülevaade: iga käigu hinnang (best, good, inaccuracy, mistake, blunder,
   * forced), parem käik ja mõlema poole täpsus. Pikk mäng võtab mõne sekundi.
   */
  app.get<{ Params: { id: string } }>('/api/games/:id/review', async (req) => {
    const game = await getGame(req.params.id);
    return { review: await store.review(game) };
  });

  /** Seisu analüüs: hinnang valge vaatenurgast ja parimad käigud. */
  app.get<{ Params: { id: string } }>('/api/games/:id/analysis', async (req) => {
    const game = await getGame(req.params.id);
    const { level, top } = parse(AnalysisQuery, req.query);
    return { analysis: analyse(game.position, level, top) };
  });

  /**
   * Otseuuendused (Server-Sent Events): äpp saab iga muutuse (käik, AI mõtleb,
   * tagasivõtt, mängu lõpp) kohe, ilma serverit pidevalt küsimata.
   * Sündmus `game` sisaldab sama objekti, mis GET /api/games/:id.
   */
  app.get<{ Params: { id: string } }>('/api/games/:id/events', async (req, reply) => {
    const game = await getGame(req.params.id);
    const send = (g: Game) => {
      const data = JSON.stringify({ game: serializeGame(g, store, players), aiMove: serializeAiMove(g.lastAiMove) });
      reply.raw.write(`event: game\nid: ${g.history.length}\ndata: ${data}\n\n`);
    };
    const unsubscribe = store.subscribe(game.id, send);
    if (!unsubscribe) throw new HttpError(429, 'Liiga palju ühendusi selle mänguga');
    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-content-type-options': 'nosniff',
      'x-accel-buffering': 'no',
    });
    reply.raw.write(`retry: 3000\n\n`);
    send(game);
    const heartbeat = setInterval(() => reply.raw.write(': ping\n\n'), SSE_HEARTBEAT_MS);
    heartbeat.unref();
    const close = () => {
      clearInterval(heartbeat);
      unsubscribe();
    };
    const end = () => {
      close();
      reply.raw.end();
    };
    streams.add(end);
    req.raw.on('close', () => {
      streams.delete(end);
      close();
    });
  });

  /** Olekuta AI käik: äpp saadab käigud algusest ja saab vastukäigu. */
  app.post('/api/ai/move', async (req) => {
    const body = parse(AiMoveBody, req.body);
    const { position } = replay(body.moves);
    const choice = await options.opponents[body.opponent].chooseMove(position, body.level);
    return { position: serializePosition(position), aiMove: serializeAiMove(choice) };
  });

  registerPlayerRoutes(app, players);
  registerBoardRoutes(app, store, { ...options.board, players: () => players.current() });

  return app;
}
