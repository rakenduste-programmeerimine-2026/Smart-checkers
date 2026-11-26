/**
 * Käivitab mänguserveri.
 *
 * Keskkonnamuutujad:
 *   PORT                  vaikimisi 3000
 *   HOST                  vaikimisi 0.0.0.0 (et laud ja telefon saaksid kohtvõrgust ligi)
 *   ANTHROPIC_API_KEY     Claude API võti välise AI vastase jaoks
 *   AI_MODEL              Claude mudel, vaikimisi claude-opus-5-5
 *   DATA_DIR              kuhu mängud salvestatakse, vaikimisi ./data
 *   API_TOKEN             äpi ligipääsuvõti (vähemalt 16 märki)
 *   BOARD_TOKEN           laua ligipääsuvõti (vähemalt 16 märki)
 *   RATE_LIMIT_PER_MIN    tavaliste päringute limiit IP kohta minutis, vaikimisi 300
 *   AI_RATE_LIMIT_PER_MIN AI-d käivitavate päringute limiit, vaikimisi 30
 *   TRUST_PROXY           "true", kui server on pöördproksi taga
 */
import { createClaudeOpponent, DEFAULT_CLAUDE_MODEL } from '../ai/claude.js';
import { createEngineOpponent } from '../ai/opponent.js';
import { join } from 'node:path';
import { PlayerStore } from '../players/store.js';
import { GameStore as RecordStore } from '../record/store.js';
import { buildApp } from './app.js';
import { DEFAULT_RATE_LIMIT } from './security.js';

const env = process.env;
const positiveInt = (value: string | undefined, fallback: number): number => {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
};

const engine = createEngineOpponent();
const dataDir = env.DATA_DIR || 'data';
const app = buildApp({
  logger: true,
  records: new RecordStore(dataDir),
  // Laiend pole .json, et mängude nimekiri seda mänguks ei peaks.
  players: new PlayerStore(join(dataDir, 'players.data')),
  trustProxy: env.TRUST_PROXY === 'true',
  security: {
    apiToken: env.API_TOKEN || undefined,
    boardToken: env.BOARD_TOKEN || undefined,
    rateLimit: {
      max: positiveInt(env.RATE_LIMIT_PER_MIN, DEFAULT_RATE_LIMIT.max),
      aiMax: positiveInt(env.AI_RATE_LIMIT_PER_MIN, DEFAULT_RATE_LIMIT.aiMax),
    },
  },
  opponents: {
    engine,
    claude: createClaudeOpponent({
      model: env.AI_MODEL || DEFAULT_CLAUDE_MODEL,
      fallback: engine,
      onError: (error) => app.log.warn({ err: error }, 'AI API päring ebaõnnestus, käis kohalik mootor'),
    }),
  },
});

if (!env.API_TOKEN && !env.BOARD_TOKEN) {
  app.log.warn('API_TOKEN ja BOARD_TOKEN pole seatud: kõik samas võrgus saavad serverit kasutada. Sea need enne päris kasutust.');
}

const port = Number(env.PORT ?? 3000);
const host = env.HOST ?? '0.0.0.0';

const shutdown = () => {
  app
    .close()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

app.listen({ port, host }).catch((error: unknown) => {
  app.log.error(error);
  process.exit(1);
});
