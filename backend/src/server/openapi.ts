/**
 * OpenAPI 3.1 kirjeldus äpi tegijatele. Ava `GET /api/openapi.json` näiteks
 * Swagger Editoris (editor.swagger.io) või impordi Postmani/Insomniasse.
 * Test kontrollib, et iga serveri tee on siin kirjas ja vastupidi.
 */
type Schema = Record<string, unknown>;

const str = (description?: string, extra: Schema = {}): Schema => ({ type: 'string', ...(description ? { description } : {}), ...extra });
const int = (description?: string, extra: Schema = {}): Schema => ({ type: 'integer', ...(description ? { description } : {}), ...extra });
const obj = (properties: Record<string, Schema>, required: string[] = []): Schema => ({ type: 'object', properties, ...(required.length ? { required } : {}) });
const ref = (name: string): Schema => ({ $ref: `#/components/schemas/${name}` });
const color = str('Värv', { enum: ['white', 'black'] });
const level = str('Raskusaste', { enum: ['beginner', 'medium', 'strong'] });

const json = (schema: Schema) => ({ 'application/json': { schema } });
const ok = (description: string, schema: Schema = obj({})) => ({ description, content: json(schema) });
const errors = (...codes: number[]) =>
  Object.fromEntries(codes.map((c) => [String(c), { description: ERROR_TEXT[c] ?? 'Viga', content: json(ref('Error')) }]));
const ERROR_TEXT: Record<number, string> = {
  400: 'Vigane sisend',
  401: 'Puudub või vale ligipääsuvõti',
  404: 'Ei leitud',
  409: 'Seis ei luba (mäng läbi, pole sinu kord, vananenud expectedPly)',
  422: 'Ebaseaduslik käik või vigane PDN',
  429: 'Liiga palju päringuid',
};

const body = (schema: Schema, required = true) => ({ required, content: json(schema) });
const idParam = (name = 'id', description = 'Id') => ({ name, in: 'path', required: true, schema: str(description) });

const GAME_ID = [idParam('id', 'Mängu id')];
const BOARD_ID = [idParam('boardId', 'Laua id, näiteks laud1')];

type Op = { summary: string; description?: string; tags: string[]; [k: string]: unknown };
const op = (o: Op): Op => ({ security: [{ bearer: [] }], ...o });

export function openApiDocument(): Record<string, unknown> {
  const gameResponse = ok('Mäng', obj({ game: ref('Game'), aiMove: { oneOf: [ref('AiMove'), { type: 'null' }] } }));
  return {
    openapi: '3.1.0',
    info: {
      title: 'Smart-checkers API',
      version: '0.1.0',
      description:
        'Nutika kabelaua (vene kabe) server äpile ja lauale. Kõik teed peale /health ja /api/openapi.json nõuavad päist `Authorization: Bearer <võti>`, kui server on võtmetega käivitatud.',
    },
    servers: [{ url: 'http://localhost:3000' }],
    tags: [
      { name: 'mängud' },
      { name: 'analüüs' },
      { name: 'mängijad' },
      { name: 'ülesanded' },
      { name: 'laud' },
      { name: 'süsteem' },
    ],
    components: {
      securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } },
      schemas: {
        Error: obj({ error: str('Veateade eesti keeles'), stale: { type: 'boolean' }, game: ref('Game') }, ['error']),
        Piece: obj({ square: str('Ruut, näiteks c3'), color, king: { type: 'boolean' } }),
        MoveDetail: obj({
          move: str('Käik, näiteks c3-d4 või c3:e5:g7'),
          from: str(),
          path: { type: 'array', items: str() },
          captures: { type: 'array', items: str() },
          promotes: { type: 'boolean' },
        }),
        Result: obj({
          status: str('', { enum: ['ongoing', 'win', 'draw'] }),
          winner: color,
          reason: str('', { enum: ['no-moves', 'time', 'resign', 'puzzle', 'king-moves', 'repetition', 'lone-king', 'agreement'] }),
        }),
        Game: obj({
          id: str(),
          opponent: str('', { enum: ['claude', 'engine', 'none'] }),
          level,
          humanColor: color,
          turn: color,
          pieces: { type: 'array', items: ref('Piece') },
          legalMoves: { type: 'array', items: str() },
          history: { type: 'array', items: str() },
          moveTimes: { type: 'array', items: str() },
          ply: int('Käikude arv; saada tagasi expectedPly-na'),
          lastMove: { oneOf: [ref('MoveDetail'), { type: 'null' }] },
          aiThinking: { type: 'boolean' },
          drawOffer: { oneOf: [color, { type: 'null' }] },
          canUndo: { type: 'boolean' },
          clock: { type: ['object', 'null'] },
          players: { type: 'object' },
          puzzle: { type: ['object', 'null'] },
          result: ref('Result'),
        }),
        AiMove: { allOf: [ref('MoveDetail'), obj({ source: str('', { enum: ['claude', 'engine'] }), reason: { type: ['string', 'null'] }, fallbackReason: { type: ['string', 'null'] } })] },
        Player: obj({
          id: str(),
          name: str(),
          rank: int(),
          rating: int(),
          bestRating: int(),
          title: str('Algaja, Harrastaja, Edasijõudnu, Ekspert, Meister'),
          stats: { type: 'object' },
        }),
        BoardDisplay: obj({
          lcd: { type: 'array', items: str('16 märki'), minItems: 2, maxItems: 2 },
          leds: { type: 'array', items: obj({ square: str(), led: int(), color: str('RRGGBB'), mode: str('', { enum: ['solid', 'blink', 'pulse'] }) }) },
          effect: str('', { enum: ['none', 'idle', 'win-white', 'win-black', 'draw'] }),
          seq: str('Muutub ainult siis, kui midagi muutub'),
        }),
      },
    },
    paths: {
      '/health': { get: { summary: 'Serveri tervis', tags: ['süsteem'], responses: { 200: ok('Töötab', obj({ status: str(), uptimeSeconds: int() })) } } },
      '/api/openapi.json': { get: { summary: 'See dokument', tags: ['süsteem'], responses: { 200: ok('OpenAPI') } } },
      '/api/games': {
        post: op({
          summary: 'Uus mäng',
          tags: ['mängud'],
          requestBody: body(
            obj({
              opponent: str('', { enum: ['claude', 'engine', 'none'], default: 'claude' }),
              level,
              humanColor: color,
              clockMinutes: int('0 = kellata', { minimum: 0, maximum: 180 }),
              players: obj({ white: str(), black: str() }),
            }),
            false,
          ),
          responses: { 201: gameResponse, ...errors(400, 404, 429) },
        }),
        get: op({ summary: 'Mängude nimekiri', tags: ['mängud'], parameters: [{ name: 'limit', in: 'query', schema: int('', { minimum: 1, maximum: 200 }) }], responses: { 200: ok('Mängud', obj({ games: { type: 'array', items: { type: 'object' } } })) } }),
      },
      '/api/games/import': { post: op({ summary: 'PDN import', tags: ['mängud'], requestBody: body(obj({ pdn: str() }, ['pdn'])), responses: { 201: gameResponse, ...errors(400, 422) } }) },
      '/api/games/{id}': {
        get: op({ summary: 'Mäng', tags: ['mängud'], parameters: GAME_ID, responses: { 200: gameResponse, ...errors(404) } }),
        delete: op({ summary: 'Kustuta mäng', tags: ['mängud'], parameters: GAME_ID, responses: { 204: { description: 'Kustutatud' }, ...errors(404) } }),
      },
      '/api/games/{id}/pdn': { get: op({ summary: 'PDN eksport', tags: ['mängud'], parameters: GAME_ID, responses: { 200: { description: 'PDN-fail', content: { 'application/x-pdn': { schema: str() } } }, ...errors(404) } }) },
      '/api/games/{id}/moves': {
        post: op({
          summary: 'Käik (AI vastab samas vastuses)',
          tags: ['mängud'],
          parameters: GAME_ID,
          requestBody: body(obj({ move: str('c3-d4'), expectedPly: int('Ohutu kordus') }, ['move'])),
          responses: { 200: gameResponse, ...errors(400, 404, 409, 422, 429) },
        }),
      },
      '/api/games/{id}/undo': { post: op({ summary: 'Võta käik tagasi', tags: ['mängud'], parameters: GAME_ID, requestBody: body(obj({ expectedPly: int() }), false), responses: { 200: ok('Mäng', obj({ game: ref('Game'), undone: int() })), ...errors(404, 409) } }) },
      '/api/games/{id}/hint': { post: op({ summary: 'Vihje', tags: ['analüüs'], parameters: GAME_ID, responses: { 200: ok('Vihje', obj({ hint: { type: ['string', 'null'] }, detail: { oneOf: [ref('MoveDetail'), { type: 'null' }] } })), ...errors(404) } }) },
      '/api/games/{id}/resign': { post: op({ summary: 'Alistu', tags: ['mängud'], parameters: GAME_ID, requestBody: body(obj({ color }), false), responses: { 200: gameResponse, ...errors(404, 409) } }) },
      '/api/games/{id}/draw': {
        post: op({
          summary: 'Viigipakkumine või -keeldumine',
          tags: ['mängud'],
          parameters: GAME_ID,
          requestBody: body(obj({ action: str('', { enum: ['offer', 'decline'] }), color }), false),
          responses: { 200: ok('Tulemus', obj({ status: str('', { enum: ['accepted', 'declined', 'pending'] }), game: ref('Game') })), ...errors(404, 409) },
        }),
      },
      '/api/games/{id}/analysis': {
        get: op({
          summary: 'Seisu analüüs',
          tags: ['analüüs'],
          parameters: [...GAME_ID, { name: 'level', in: 'query', schema: level }, { name: 'top', in: 'query', schema: int('', { minimum: 1, maximum: 10 }) }],
          responses: { 200: ok('Analüüs', obj({ analysis: obj({ score: int(), summary: str(), depth: int(), bestMoves: { type: 'array', items: ref('MoveDetail') } }) })), ...errors(404) },
        }),
      },
      '/api/games/{id}/review': { get: op({ summary: 'Mänguülevaade (vead ja täpsus)', tags: ['analüüs'], parameters: GAME_ID, responses: { 200: ok('Ülevaade', obj({ review: obj({ moves: { type: 'array' }, summary: { type: 'object' }, keyMoments: { type: 'array', items: int() } }) })), ...errors(404) } }) },
      '/api/games/{id}/puzzles': { post: op({ summary: 'Ülesanded mängu vigadest', tags: ['ülesanded'], parameters: GAME_ID, responses: { 200: ok('Ülesanded', obj({ puzzles: { type: 'array' } })), ...errors(404) } }) },
      '/api/games/{id}/events': { get: op({ summary: 'Otseuuendused (Server-Sent Events)', description: 'Sündmus `game` andmetega `{ game, aiMove }` iga muutuse korral; iga 15 s `: ping`.', tags: ['mängud'], parameters: GAME_ID, responses: { 200: { description: 'text/event-stream', content: { 'text/event-stream': { schema: str() } } }, ...errors(404, 429) } }) },
      '/api/ai/move': { post: op({ summary: 'Olekuta AI käik', tags: ['analüüs'], requestBody: body(obj({ moves: { type: 'array', items: str() }, opponent: str('', { enum: ['engine', 'claude'] }), level })), responses: { 200: ok('Käik', obj({ position: { type: 'object' }, aiMove: { oneOf: [ref('AiMove'), { type: 'null' }] } })), ...errors(400) } }) },
      '/api/players': {
        post: op({ summary: 'Uus mängija', tags: ['mängijad'], requestBody: body(obj({ name: str('1–24 märki') }, ['name'])), responses: { 201: ok('Mängija', obj({ player: ref('Player') })), ...errors(400, 409) } }),
        get: op({ summary: 'Edetabel', tags: ['mängijad'], parameters: [{ name: 'limit', in: 'query', schema: int() }], responses: { 200: ok('Edetabel', obj({ players: { type: 'array', items: ref('Player') } })) } }),
      },
      '/api/players/{id}': {
        get: op({ summary: 'Mängija ja reitingu ajalugu', tags: ['mängijad'], parameters: [idParam()], responses: { 200: ok('Mängija', obj({ player: ref('Player') })), ...errors(404) } }),
        patch: op({ summary: 'Nimeta ümber', tags: ['mängijad'], parameters: [idParam()], requestBody: body(obj({ name: str() }, ['name'])), responses: { 200: ok('Mängija', obj({ player: ref('Player') })), ...errors(400, 404, 409) } }),
        delete: op({ summary: 'Kustuta mängija', tags: ['mängijad'], parameters: [idParam()], responses: { 204: { description: 'Kustutatud' }, ...errors(404) } }),
      },
      '/api/puzzles': { get: op({ summary: 'Ülesannete nimekiri', tags: ['ülesanded'], responses: { 200: ok('Ülesanded', obj({ puzzles: { type: 'array' } })) } }) },
      '/api/puzzles/{id}': { get: op({ summary: 'Ülesanne', tags: ['ülesanded'], parameters: [idParam()], responses: { 200: ok('Ülesanne', obj({ puzzle: { type: 'object' } })), ...errors(404) } }) },
      '/api/puzzles/{id}/start': { post: op({ summary: 'Alusta ülesannet', tags: ['ülesanded'], parameters: [idParam()], requestBody: body(obj({ playerId: str() }), false), responses: { 201: gameResponse, ...errors(404) } }) },
      '/api/board/{boardId}': { get: op({ summary: 'Laua olek', tags: ['laud'], parameters: BOARD_ID, responses: { 200: ok('Laud', obj({ board: { type: 'object' }, display: ref('BoardDisplay') })), ...errors(400) } }) },
      '/api/board/{boardId}/state': {
        post: op({
          summary: 'Laua põhipäring (~5 korda sekundis)',
          description: 'Laud saadab hõivatusmaski ja vajutatud nupud, saab LCD read ja LED-id. Lubatud ka laua võtmega (BOARD_TOKEN).',
          tags: ['laud'],
          parameters: BOARD_ID,
          requestBody: body(obj({ mask: { oneOf: [int('0…0xffffffff'), str('kuueteistkümnendarv')] }, buttons: { type: 'array', items: int('', { enum: [1, 2, 3] }) } })),
          responses: { 200: ok('Mida näidata', ref('BoardDisplay')), ...errors(400, 401, 429) },
        }),
      },
      '/api/board/{boardId}/health': { get: op({ summary: 'Laua tervis ja andurid', tags: ['laud'], parameters: BOARD_ID, responses: { 200: ok('Tervis', obj({ health: { type: 'object' } })) } }) },
      '/api/board/{boardId}/attach': { post: op({ summary: 'Seo laud mänguga', tags: ['laud'], parameters: BOARD_ID, requestBody: body(obj({ gameId: str() }, ['gameId'])), responses: { 200: ok('Laud'), ...errors(404) } }) },
      '/api/board/{boardId}/replay': { post: op({ summary: 'Mängi mäng laual läbi', tags: ['laud'], parameters: BOARD_ID, requestBody: body(obj({ gameId: str() }, ['gameId'])), responses: { 200: ok('Laud'), ...errors(404) } }) },
      '/api/board/{boardId}/puzzle': { post: op({ summary: 'Ülesanne laual', tags: ['laud'], parameters: BOARD_ID, requestBody: body(obj({ puzzleId: str() }, ['puzzleId'])), responses: { 201: ok('Laud'), ...errors(404) } }) },
      '/api/board/{boardId}/games': { post: op({ summary: 'Uus mäng laual', tags: ['laud'], parameters: BOARD_ID, requestBody: body(obj({ opponent: str(), level, humanColor: color, clockMinutes: int(), playerId: { type: ['string', 'null'] } }), false), responses: { 201: ok('Laud') } }) },
      '/api/matches': { post: op({ summary: 'Võrgumäng kahe laua vahel', tags: ['laud'], requestBody: body(obj({ white: str('Laua id'), black: str('Laua id'), clockMinutes: int() }, ['white', 'black'])), responses: { 201: ok('Mäng ja lauad', obj({ gameId: str(), boards: { type: 'array' } })), ...errors(400) } }) },
    },
  };
}
