import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { createEngineOpponent } from '../../src/ai/opponent.js';
import { buildApp, BODY_LIMIT } from '../../src/server/app.js';
import { checkTokens, tokenMatches, type SecurityOptions } from '../../src/server/security.js';

const API = 'app-voti-0123456789abcdef';
const BOARD = 'laua-voti-0123456789abcdef';
const engine = createEngineOpponent(() => 0);
let app: FastifyInstance;
const start = (security: SecurityOptions = { apiToken: API, boardToken: BOARD }) => {
  app = buildApp({ opponents: { engine, claude: engine }, security, board: { timing: { settleMs: 0 } } });
  return app;
};
afterEach(async () => app?.close());

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

describe('ligipääsuvõtmed', () => {
  it('health on avalik, muu nõuab võtit', async () => {
    start();
    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    const none = await app.inject({ method: 'GET', url: '/api/games' });
    expect(none.statusCode).toBe(401);
    expect(none.json().error).toMatch(/Puudub/);
    expect((await app.inject({ method: 'GET', url: '/api/games', headers: auth('vale-voti-0123456789') })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/games', headers: { authorization: API } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/games', headers: auth(API) })).statusCode).toBe(200);
  });

  it('laua võti sobib ainult laua olekupäringule', async () => {
    start();
    const state = await app.inject({ method: 'POST', url: '/api/board/laud1/state', headers: auth(BOARD), payload: { mask: 0 } });
    expect(state.statusCode).toBe(200);
    const games = await app.inject({ method: 'POST', url: '/api/games', headers: auth(BOARD), payload: {} });
    expect(games.statusCode).toBe(403);
    const attach = await app.inject({ method: 'POST', url: '/api/board/laud1/games', headers: auth(BOARD), payload: {} });
    expect(attach.statusCode).toBe(403);
    // Äpi võtmega saab ka laua teed.
    expect((await app.inject({ method: 'GET', url: '/api/board/laud1', headers: auth(API) })).statusCode).toBe(200);
  });

  it('ilma võtmeteta on server avatud (arendus)', async () => {
    start({});
    expect((await app.inject({ method: 'GET', url: '/api/games' })).statusCode).toBe(200);
  });

  it('keeldub liiga lühikesest võtmest', () => {
    expect(() => checkTokens({ apiToken: 'lyhike' })).toThrow(/16/);
    expect(() => checkTokens({ apiToken: API, boardToken: BOARD })).not.toThrow();
  });

  it('võrdleb võtmeid õigesti', () => {
    expect(tokenMatches(API, API)).toBe(true);
    expect(tokenMatches(`${API}x`, API)).toBe(false);
    expect(tokenMatches('', API)).toBe(false);
  });
});

describe('päringulimiit', () => {
  it('piirab AI päringuid rangemalt ja annab retry-after päise', async () => {
    start({ rateLimit: { aiMax: 2, max: 100 } });
    const ai = () => app.inject({ method: 'POST', url: '/api/ai/move', payload: { opponent: 'engine' } });
    expect((await ai()).statusCode).toBe(200);
    const second = await ai();
    expect(second.headers['x-ratelimit-remaining']).toBe('0');
    const third = await ai();
    expect(third.statusCode).toBe(429);
    expect(Number(third.headers['retry-after'])).toBeGreaterThan(0);
    // Tavalised päringud käivad edasi.
    expect((await app.inject({ method: 'GET', url: '/api/games' })).statusCode).toBe(200);
  });

  it('piirab IP kaupa', async () => {
    start({ rateLimit: { max: 1 } });
    const get = (ip: string) => app.inject({ method: 'GET', url: '/api/games', remoteAddress: ip });
    expect((await get('10.0.0.1')).statusCode).toBe(200);
    expect((await get('10.0.0.1')).statusCode).toBe(429);
    expect((await get('10.0.0.2')).statusCode).toBe(200);
  });
});

describe('sisendi piirid ja päised', () => {
  it('lisab turvapäised', async () => {
    start({});
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.headers).toMatchObject({
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
    });
  });

  it('keeldub liiga suurest kehast ja vigasest JSON-ist', async () => {
    start({});
    const big = await app.inject({
      method: 'POST',
      url: '/api/games/import',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ pdn: 'x'.repeat(BODY_LIMIT) }),
    });
    expect(big.statusCode).toBe(413);
    expect(big.json().error).toBe('Päring on liiga suur');
    const broken = await app.inject({
      method: 'POST',
      url: '/api/games',
      headers: { 'content-type': 'application/json' },
      payload: '{"opponent":',
    });
    expect(broken.statusCode).toBe(400);
    const tooLongPdn = await app.inject({ method: 'POST', url: '/api/games/import', payload: { pdn: 'x'.repeat(100_001) } });
    expect(tooLongPdn.statusCode).toBe(400);
  });

  it('tundmatu tee annab 404 ega lekita sisemist infot', async () => {
    start({});
    const res = await app.inject({ method: 'GET', url: '/api/olematu' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'Sellist teed pole' });
  });

  it('peidab serveri vea üksikasjad', async () => {
    const broken = { kind: 'engine' as const, chooseMove: async () => { throw new Error('salajane sisemine viga'); } };
    app = buildApp({ opponents: { engine: broken, claude: broken } });
    const res = await app.inject({ method: 'POST', url: '/api/ai/move', payload: { opponent: 'engine' } });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: 'Serveri viga' });
  });

  it('kontrollib laua id-d ja käikude arvu', async () => {
    start({});
    expect((await app.inject({ method: 'GET', url: `/api/board/${'a'.repeat(33)}` })).statusCode).toBe(400);
    const many = await app.inject({ method: 'POST', url: '/api/ai/move', payload: { moves: Array(501).fill('c3-d4') } });
    expect(many.statusCode).toBe(400);
  });
});
