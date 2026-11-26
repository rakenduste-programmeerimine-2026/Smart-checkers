import { request, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createEngineOpponent, type Opponent } from '../../src/ai/opponent.js';
import { formatMove, legalMoves } from '../../src/game/rules.js';
import { buildApp } from '../../src/server/app.js';

const firstMove: Opponent = {
  kind: 'claude',
  async chooseMove(pos) {
    const move = legalMoves(pos)[0];
    return move ? { move, notation: formatMove(move), source: 'claude' } : null;
  },
};

let app: FastifyInstance;
afterEach(async () => app?.close());

/** Avab SSE ühenduse ja kogub sündmusi. */
const open = (port: number, path: string, headers: Record<string, string> = {}) =>
  new Promise<{ res: IncomingMessage; events: () => { event: string; data: any }[]; next: (n: number) => Promise<void> }>(
    (resolve, reject) => {
      const req = request({ port, path, headers }, (res) => {
        let buffer = '';
        const waiters: { n: number; done: () => void }[] = [];
        const parsed: { event: string; data: any }[] = [];
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          buffer += chunk;
          let idx;
          while ((idx = buffer.indexOf('\n\n')) >= 0) {
            const block = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            const event = /^event: (.*)$/m.exec(block)?.[1];
            const data = /^data: (.*)$/m.exec(block)?.[1];
            if (event && data) parsed.push({ event, data: JSON.parse(data) });
          }
          for (const w of [...waiters]) if (parsed.length >= w.n) w.done();
        });
        resolve({
          res,
          events: () => parsed,
          next: (n) =>
            new Promise<void>((done) => {
              if (parsed.length >= n) done();
              else waiters.push({ n, done });
            }),
        });
      });
      req.on('error', reject);
      req.end();
    },
  );

describe('otseuuendused (SSE)', () => {
  it('saadab praeguse seisu ja iga muutuse', async () => {
    app = buildApp({ opponents: { engine: createEngineOpponent(() => 0), claude: firstMove } });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = app.server.address() as AddressInfo;
    const created = await app.inject({ method: 'POST', url: '/api/games', payload: {} });
    const id = created.json().game.id as string;

    const stream = await open(port, `/api/games/${id}/events`);
    expect(stream.res.statusCode).toBe(200);
    expect(stream.res.headers['content-type']).toContain('text/event-stream');
    await stream.next(1);
    expect(stream.events()[0]).toMatchObject({ event: 'game', data: { game: { id, ply: 0 } } });

    await app.inject({ method: 'POST', url: `/api/games/${id}/moves`, payload: { move: 'c3-d4' } });
    await stream.next(4);
    const plies = stream.events().map((e) => `${e.data.game.ply}:${e.data.game.aiThinking}`);
    expect(plies).toEqual(['0:false', '1:false', '1:true', '2:false']);
    expect(stream.events()[3]!.data.aiMove).toMatchObject({ source: 'claude' });
    stream.res.destroy();
  });

  it('nõuab ligipääsuvõtit ja tundmatu mäng annab 404', async () => {
    const token = 'a'.repeat(32);
    app = buildApp({
      opponents: { engine: createEngineOpponent(() => 0), claude: firstMove },
      security: { apiToken: token },
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = app.server.address() as AddressInfo;
    expect((await open(port, '/api/games/x/events')).res.statusCode).toBe(401);
    const missing = await open(port, '/api/games/puudub/events', { authorization: `Bearer ${token}` });
    expect(missing.res.statusCode).toBe(404);
    missing.res.destroy();
  });

  it('serveri sulgemine lõpetab avatud ühendused', async () => {
    app = buildApp({ opponents: { engine: createEngineOpponent(() => 0), claude: firstMove } });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = app.server.address() as AddressInfo;
    const id = (await app.inject({ method: 'POST', url: '/api/games', payload: { opponent: 'none' } })).json().game.id;
    const stream = await open(port, `/api/games/${id}/events`);
    await stream.next(1);
    const ended = new Promise<void>((resolve) => stream.res.on('end', resolve));
    await app.close();
    await ended;
  });
});
