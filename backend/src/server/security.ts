/**
 * Turvalisus: ligipääsuvõtmed, päringulimiit ja turvapäised.
 *
 * - Äpp saadab päise `Authorization: Bearer <API_TOKEN>`.
 * - Laud saadab `Authorization: Bearer <BOARD_TOKEN>`; laua võtmega pääseb ainult
 *   laua olekupäringule (`POST /api/board/:id/state`), mitte mängude haldusele.
 * - Kui võtmeid pole seatud, on server avatud (arendus); main.ts hoiatab selle eest.
 * - Päringulimiit on IP kaupa fikseeritud aknaga. AI-d käivitavatel päringutel
 *   (raha maksev Claude API) on rangem limiit.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

export interface SecurityOptions {
  /** Äpi võti: annab ligipääsu kogu API-le. */
  apiToken?: string;
  /** Laua võti: ainult laua olekupäring. */
  boardToken?: string;
  rateLimit?: Partial<RateLimitOptions>;
}

export interface RateLimitOptions {
  windowMs: number;
  /** Tavalised päringud akna kohta IP-st. */
  max: number;
  /** Laua olekupäringud (laud küsib ~5 korda sekundis). */
  boardMax: number;
  /** AI-d käivitavad päringud (uus mäng, käik, olekuta AI käik). */
  aiMax: number;
}

export const DEFAULT_RATE_LIMIT: RateLimitOptions = { windowMs: 60_000, max: 300, boardMax: 900, aiMax: 30 };

/** Lühim lubatud võti, et nõrka võtit kogemata ei kasutataks. */
export const MIN_TOKEN_LENGTH = 16;

type Role = 'public' | 'board' | 'api';
type Bucket = 'general' | 'board' | 'ai';

const digest = (value: string) => createHash('sha256').update(value).digest();

/** Võrdleb võtmeid konstantse ajaga (räsid on alati sama pikkusega). */
export function tokenMatches(given: string, expected: string): boolean {
  return timingSafeEqual(digest(given), digest(expected));
}

function bearer(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return match?.[1] ?? null;
}

const routeOf = (req: FastifyRequest) => req.routeOptions.url ?? req.url.split('?')[0] ?? '';

function requiredRole(req: FastifyRequest): Role {
  const url = routeOf(req);
  if (url === '/health' || url === '/api/openapi.json') return 'public';
  if (req.method === 'POST' && url === '/api/board/:boardId/state') return 'board';
  return 'api';
}

function bucketOf(req: FastifyRequest): Bucket {
  const url = routeOf(req);
  if (req.method === 'POST' && url === '/api/board/:boardId/state') return 'board';
  if (req.method === 'POST' && (url === '/api/games' || url === '/api/games/:id/moves' || url === '/api/ai/move')) {
    return 'ai';
  }
  // Analüüs ja vihje koormavad protsessorit.
  if (
    url === '/api/games/:id/analysis' ||
    url === '/api/games/:id/hint' ||
    url === '/api/games/:id/review' ||
    url === '/api/games/:id/puzzles'
  ) {
    return 'ai';
  }
  return 'general';
}

export function checkTokens(options: SecurityOptions): void {
  for (const [name, token] of [
    ['API_TOKEN', options.apiToken],
    ['BOARD_TOKEN', options.boardToken],
  ] as const) {
    if (token !== undefined && token.length < MIN_TOKEN_LENGTH) {
      throw new Error(`${name} peab olema vähemalt ${MIN_TOKEN_LENGTH} märki pikk`);
    }
  }
}

export function registerSecurity(app: FastifyInstance, options: SecurityOptions = {}): void {
  checkTokens(options);
  const limits = { ...DEFAULT_RATE_LIMIT, ...options.rateLimit };
  const { apiToken, boardToken } = options;
  const windows = new Map<string, { start: number; count: number }>();

  const deny = (reply: FastifyReply, status: number, error: string) => reply.status(status).send({ error });

  app.addHook('onRequest', async (req, reply) => {
    // --- päringulimiit ---
    const bucket = bucketOf(req);
    const max = bucket === 'ai' ? limits.aiMax : bucket === 'board' ? limits.boardMax : limits.max;
    const key = `${req.ip}|${bucket}`;
    const now = Date.now();
    let window = windows.get(key);
    if (!window || now - window.start >= limits.windowMs) {
      window = { start: now, count: 0 };
      windows.set(key, window);
      if (windows.size > 10_000) {
        for (const [k, w] of windows) if (now - w.start >= limits.windowMs) windows.delete(k);
      }
    }
    window.count++;
    reply.header('x-ratelimit-limit', max);
    reply.header('x-ratelimit-remaining', Math.max(0, max - window.count));
    if (window.count > max) {
      reply.header('retry-after', Math.ceil((window.start + limits.windowMs - now) / 1000));
      return deny(reply, 429, 'Liiga palju päringuid, proovi hiljem uuesti');
    }

    // --- ligipääs ---
    const role = requiredRole(req);
    if (role === 'public' || (!apiToken && !boardToken)) return;
    const token = bearer(req);
    if (!token) return deny(reply, 401, 'Puudub ligipääsuvõti (Authorization: Bearer ...)');
    const isApi = apiToken !== undefined && tokenMatches(token, apiToken);
    const isBoard = boardToken !== undefined && tokenMatches(token, boardToken);
    if (isApi || (role === 'board' && isBoard)) return;
    return deny(reply, isBoard ? 403 : 401, isBoard ? 'Laua võtmega sellele ligi ei pääse' : 'Vale ligipääsuvõti');
  });

  app.addHook('onSend', async (_req, reply) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'DENY');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('content-security-policy', "default-src 'none'; frame-ancestors 'none'");
    reply.header('cache-control', 'no-store');
  });
}
