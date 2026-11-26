/** Mängijate ja edetabeli API. */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HttpError, parse } from '../server/http.js';
import { PlayerError, type PlayerStore } from './store.js';

const NameBody = z.object({ name: z.string().min(1).max(64) });
const IdParams = z.object({ id: z.string().min(1).max(64) });
const LeaderboardQuery = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) });

const wrap = async <T>(fn: () => Promise<T>): Promise<T> => {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof PlayerError) throw new HttpError(error.statusCode, error.message);
    throw error;
  }
};

export function registerPlayerRoutes(app: FastifyInstance, players: PlayerStore): void {
  app.post('/api/players', async (req, reply) => {
    const { name } = parse(NameBody, req.body);
    const player = await wrap(() => players.create(name));
    reply.status(201);
    return { player: await players.publicPlayer(player.id) };
  });

  /** Edetabel: koht, nimi, reiting, tiitel ja statistika. */
  app.get('/api/players', async (req) => {
    const { limit } = parse(LeaderboardQuery, req.query);
    return { players: await players.leaderboard(limit) };
  });

  app.get('/api/players/:id', async (req) => {
    const { id } = parse(IdParams, req.params);
    const player = await players.publicPlayer(id);
    if (!player) throw new HttpError(404, 'Mängijat ei leitud');
    return { player };
  });

  app.patch('/api/players/:id', async (req) => {
    const { id } = parse(IdParams, req.params);
    const { name } = parse(NameBody, req.body);
    await wrap(() => players.rename(id, name));
    return { player: await players.publicPlayer(id) };
  });

  app.delete('/api/players/:id', async (req, reply) => {
    const { id } = parse(IdParams, req.params);
    if (!(await players.delete(id))) throw new HttpError(404, 'Mängijat ei leitud');
    reply.status(204);
    return null;
  });
}
