/**
 * Mänguserveri REST API (Fastify).
 *
 * Mängud hoitakse praegu mälus; andmebaasi lisab hiljem see, kes salvestamisega tegeleb.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { applyMove, findMove, formatMove, gameResult, initialPosition, legalMoves } from '../game/rules.js';
import { squareName } from '../game/squares.js';
import type { Color, GameResult, Position } from '../game/types.js';
import { suggestMove, type AiLevel } from '../ai/engine.js';
import type { Opponent, OpponentKind, OpponentMove } from '../ai/opponent.js';

export interface Game {
  id: string;
  /** Kes mängib arvuti vastu: null = kaks inimest laual. */
  opponent: OpponentKind | null;
  level: AiLevel;
  humanColor: Color;
  position: Position;
  history: string[];
  createdAt: string;
}

export interface AppOptions {
  opponents: Record<OpponentKind, Opponent>;
  logger?: boolean;
}

const Level = z.enum(['beginner', 'medium', 'strong']);
const OpponentSchema = z.enum(['engine', 'claude', 'none']);

const CreateGameBody = z.object({
  opponent: OpponentSchema.default('claude'),
  level: Level.default('medium'),
  humanColor: z.enum(['white', 'black']).default('white'),
});

const MoveBody = z.object({ move: z.string().min(4).max(64) });

const AiMoveBody = z.object({
  /** Käigud algseisust alates, näiteks ["c3-d4", "f6-e5"]. */
  moves: z.array(z.string().min(4).max(64)).max(500).default([]),
  opponent: z.enum(['engine', 'claude']).default('claude'),
  level: Level.default('medium'),
});

class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

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

function serializePosition(position: Position) {
  return {
    turn: position.turn,
    pieces: position.board.flatMap((piece, sq) =>
      piece ? [{ square: squareName(sq), color: piece.color, king: piece.king }] : [],
    ),
    legalMoves: legalMoves(position).map(formatMove),
  };
}

function serializeGame(game: Game) {
  const result: GameResult = gameResult(game.position);
  return {
    id: game.id,
    opponent: game.opponent ?? 'none',
    level: game.level,
    humanColor: game.humanColor,
    createdAt: game.createdAt,
    history: game.history,
    result,
    ...serializePosition(game.position),
  };
}

function serializeAiMove(m: OpponentMove | null) {
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

function parse<S extends z.ZodTypeAny>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value ?? {});
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new HttpError(400, `Vigane sisend: ${issue?.path.join('.') || 'body'} ${issue?.message ?? ''}`.trim());
  }
  return result.data;
}

export function buildApp(options: AppOptions): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? false });
  const games = new Map<string, Game>();

  app.setErrorHandler((error, _req, reply) => {
    const status = error instanceof HttpError ? error.statusCode : (error.statusCode ?? 500);
    reply.status(status).send({ error: status >= 500 ? 'Serveri viga' : error.message });
  });

  const getGame = (id: string): Game => {
    const game = games.get(id);
    if (!game) throw new HttpError(404, 'Mängu ei leitud');
    return game;
  };

  /** Kui on AI kord, laseb AI-l käia. */
  const aiTurn = async (game: Game): Promise<OpponentMove | null> => {
    if (!game.opponent || game.position.turn === game.humanColor) return null;
    if (gameResult(game.position).status !== 'ongoing') return null;
    const choice = await options.opponents[game.opponent].chooseMove(game.position, game.level);
    if (!choice) return null;
    game.position = applyMove(game.position, choice.move);
    game.history.push(choice.notation);
    return choice;
  };

  app.get('/health', async () => ({ status: 'ok' }));

  app.post('/api/games', async (req, reply) => {
    const body = parse(CreateGameBody, req.body);
    const game: Game = {
      id: randomUUID(),
      opponent: body.opponent === 'none' ? null : body.opponent,
      level: body.level,
      humanColor: body.humanColor,
      position: initialPosition(),
      history: [],
      createdAt: new Date().toISOString(),
    };
    games.set(game.id, game);
    // Kui inimene on must, alustab AI.
    const aiMove = await aiTurn(game);
    reply.status(201);
    return { game: serializeGame(game), aiMove: serializeAiMove(aiMove) };
  });

  app.get<{ Params: { id: string } }>('/api/games/:id', async (req) => ({ game: serializeGame(getGame(req.params.id)) }));

  app.post<{ Params: { id: string } }>('/api/games/:id/moves', async (req) => {
    const game = getGame(req.params.id);
    const { move: text } = parse(MoveBody, req.body);
    if (gameResult(game.position).status !== 'ongoing') throw new HttpError(409, 'Mäng on juba läbi');
    if (game.opponent && game.position.turn !== game.humanColor) throw new HttpError(409, 'Praegu on AI kord');
    const move = findMove(game.position, text);
    if (!move) throw new HttpError(422, `Käik "${text}" pole seaduslik või pole üheselt mõistetav`);
    game.position = applyMove(game.position, move);
    game.history.push(formatMove(move));
    const aiMove = await aiTurn(game);
    return { game: serializeGame(game), aiMove: serializeAiMove(aiMove) };
  });

  app.post<{ Params: { id: string } }>('/api/games/:id/hint', async (req) => {
    const game = getGame(req.params.id);
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

  return app;
}
