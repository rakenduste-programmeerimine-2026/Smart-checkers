/**
 * Käivitab mänguserveri.
 *
 * Keskkonnamuutujad:
 *   PORT              vaikimisi 3000
 *   HOST              vaikimisi 0.0.0.0 (et laud ja telefon saaksid kohtvõrgust ligi)
 *   ANTHROPIC_API_KEY Claude API võti välise AI vastase jaoks
 *   AI_MODEL          Claude mudel, vaikimisi claude-opus-5-5
 *   DATA_DIR          kuhu mängud salvestatakse, vaikimisi ./data
 */
import { createClaudeOpponent, DEFAULT_CLAUDE_MODEL } from '../ai/claude.js';
import { createEngineOpponent } from '../ai/opponent.js';
import { GameStore as RecordStore } from '../record/store.js';
import { buildApp } from './app.js';

const engine = createEngineOpponent();
const app = buildApp({
  logger: true,
  records: new RecordStore(process.env.DATA_DIR || 'data'),
  opponents: {
    engine,
    claude: createClaudeOpponent({
      model: process.env.AI_MODEL || DEFAULT_CLAUDE_MODEL,
      fallback: engine,
      onError: (error) => app.log.warn({ err: error }, 'AI API päring ebaõnnestus, käis kohalik mootor'),
    }),
  },
});

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '0.0.0.0';

app.listen({ port, host }).catch((error: unknown) => {
  app.log.error(error);
  process.exit(1);
});
