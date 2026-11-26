# Smart-checkers

Nutika kabelaua mänguserver. Laud (Arduino UNO R4 WiFi, 32 reed-lülitit, LED-riba, LCD) ja iOS äpp (Expo) räägivad selle serveriga, mis hoiab kabe reegleid, AI vastast ning API-t äpile ja lauale.

## Mis siin praegu on

- `src/game/squares.ts`: tumedate ruutude numeratsioon 0–31, mis vastab laua reed-lülitite bittidele.
- `src/game/rules.ts`: kabe (vene kabe) reeglid, mis hõlmavad kohustuslikku löömist, lendavat tammi, türgi löögi keeldu, tammiks saamist löömise ajal ning võitu ja viiki.
- `src/game/sensors.ts`: laua 32-bitise hõivatusmaski tõlgendamine käiguks.
- `src/ai/engine.ts`: kohalik AI mootor (negamax alfa-beeta kärpimisega). Tasemed on `beginner` (2 poolkäiku, teeb vahel vigu), `medium` (4 poolkäiku) ja `strong` (7 poolkäiku). Lisaks on `suggestMove` vihje andmiseks.
- `src/ai/claude.ts`: AI vastane välise AI API (Claude) kaudu. Mudel saab laua seisu ja nummerdatud seaduslikud käigud ning valib neist ühe, nii et ebaseaduslikku käiku ta teha ei saa. Kui API ei vasta, käib kohalik mootor.
- `src/server/`: REST API (Fastify) ja mängude haldus (`games.ts`: kõik seisud, käigu tagasivõtt, AI taustal).
- `src/board/`: füüsilise laua ühendus. `controller.ts` tunneb maskist käigu ära ja otsustab, mida LED-id ja LCD näitavad, `display.ts` teeb LED-riba numeratsiooni ja LCD teksti.
- `src/record/`: mängude salvestamine laua magnetite järgi. `Game` peab mängu logi (käik ja aeg, tagasivõtt), `BoardTracker` paneb käigu kirja alles siis, kui laua mask on püsinud (vaikimisi 300 ms), `toPdn` ja `gameFromPdn` teevad PDN-ekspordi ja -impordi (vene kabe, GameType 25) ning `GameStore` salvestab mängud JSON-failidena.

## Käivitamine

```bash
npm install
npm run dev       # server pordil 3000, muudatustel taaskäivitus
npm test          # testid (Vitest)
npm run typecheck # TypeScripti kontroll
npm run build     # kompileerib kausta dist/
```

Vaja on Node 20 või uuemat.

### Keskkonnamuutujad

| Muutuja | Vaikimisi | Tähendus |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | – | Claude API võti välise AI vastase jaoks. Ilma selleta mängib kohalik mootor. |
| `AI_MODEL` | `claude-opus-5-5` | Claude mudel |
| `DATA_DIR` | `data` | Kaust, kuhu mängud JSON-failidena salvestatakse |
| `PORT` | `3000` | Serveri port |
| `HOST` | `0.0.0.0` | Kuulatav aadress (laud ja telefon on samas võrgus) |

## REST API

Kõik vastused on JSON-is. Vead tulevad kujul `{ "error": "..." }` ja koodiga 400 (vigane sisend), 404 (mängu pole), 409 (pole sinu kord või mäng on läbi) või 422 (ebaseaduslik käik).

| Meetod | Tee | Keha | Vastus |
| --- | --- | --- | --- |
| `GET` | `/health` | – | `{ status: "ok" }` |
| `POST` | `/api/games` | `{ opponent?: "claude" \| "engine" \| "none", level?: "beginner" \| "medium" \| "strong", humanColor?: "white" \| "black" }` | `{ game, aiMove }` (AI alustab, kui inimene on must) |
| `GET` | `/api/games?limit=50` | – | `{ games: [{ id, meta, moveCount, result, endedAt? }] }` (uuemad eespool, ka kettal olevad) |
| `GET` | `/api/games/:id` | – | `{ game }` (mälust või kettalt) |
| `GET` | `/api/games/:id/pdn` | – | PDN-fail (vene kabe, GameType 25) |
| `POST` | `/api/games/import` | `{ pdn: "..." }` | `{ game }` (kahe inimese mänguks) |
| `DELETE` | `/api/games/:id` | – | 204 |
| `POST` | `/api/games/:id/moves` | `{ move: "c3-d4" }` | `{ game, aiMove }` (AI vastukäik kohe sama vastusega) |
| `POST` | `/api/games/:id/hint` | – | `{ hint: "c3-d4" }` |
| `POST` | `/api/games/:id/undo` | – | `{ game, undone }` (inimese viimane käik ja AI vastus) |
| `POST` | `/api/ai/move` | `{ moves: ["c3-d4", ...], opponent?, level? }` | `{ position, aiMove }` (olekuta: käigud algusest) |

`game` sisaldab välju `id`, `opponent`, `level`, `humanColor`, `turn`, `pieces` (`[{ square, color, king }]`), `legalMoves`, `history` ja `result` (`ongoing`, `win` koos `winner`-iga või `draw`).

`aiMove` sisaldab välju `move`, `from`, `path`, `captures`, `promotes`, `source` (`claude` või `engine`), `reason` (AI põhjendus) ja `fallbackReason` (miks kohalik mootor välise AI asemel käis).

Näide:

```bash
curl -X POST localhost:3000/api/games -H 'content-type: application/json' -d '{"opponent":"claude","level":"medium"}'
curl -X POST localhost:3000/api/games/<id>/moves -H 'content-type: application/json' -d '{"move":"c3-d4"}'
```

## Laua API

Laud küsib serverilt umbes 5 korda sekundis. Kõik laua teed on kujul `/api/board/:boardId/...`, kus `boardId` on näiteks `laud1`.

| Meetod | Tee | Keha | Vastus |
| --- | --- | --- | --- |
| `POST` | `/api/board/:boardId/state` | `{ mask: 4293922815 \| "0xfff00fff", buttons?: [1, 2, 3] }` | `{ lcd, leds, effect, seq }` |
| `GET` | `/api/board/:boardId` | – | `{ board, display }` (olek äpi jaoks) |
| `POST` | `/api/board/:boardId/games` | `{ opponent?, level?, humanColor? }` | `{ board, display }` (uus mäng laual) |
| `POST` | `/api/board/:boardId/attach` | `{ gameId }` | `{ board, display }` (seob äpis loodud mänguga) |
| `POST` | `/api/board/:boardId/replay` | `{ gameId }` | `{ board, display }` (kordus laual: B1 tagasi, B2 edasi, B3 välja) |

Vastuses on `lcd` kaks 16-märgilist rida (täpitähed on asendatud, sest LCD neid ei oska), `leds` on nimekiri `{ square, led, color: "RRGGBB", mode: "solid" | "blink" | "pulse" }` ja `effect` on `none`, `idle` (hingav ootel valgus), `win-white`, `win-black` või `draw`. LED-id, mida nimekirjas pole, on kustus. `seq` muutub ainult siis, kui midagi muutub, nii et laud ei pea iga kord uuesti joonistama.

Käik loetakse tehtuks, kui mask on 300 ms paigal. Vale seisu näidatakse alles siis, kui see püsib 2,5 s, et pooleli löömist veaks ei loetaks.

### LED-id

| Värv | Tähendus |
| --- | --- |
| Kollane | AI (või äpis tehtud) käigu algusruut |
| Sinine | Löömise vahepealne ruut |
| Roheline | Käigu lõpp või tõstetud nupu võimalik sihtruut |
| Punane vilkuv | Löödav nupp või ruut, kuhu on vaja nupp panna |
| Lilla vilkuv | Ruut, kust tuleb nupp ära võtta |
| Oranž vilkuv | Nupp, mis peab lööma (löömine on kohustuslik) |
| Helesinine | Vihje |
| Valge | Tõstetud nupu algruut |

LED-riba on üks 160 LED-iga tükk, mis käib ridade kaupa edasi-tagasi: `a1 → 0`, `c1 → 4`, `e1 → 8`, `g1 → 12`, `h2 → 21`, `f2 → 25`, …, `b8 → 159` (vt `ledIndex`).

### Kaane nupud

| Nupp | Mängus | Menüüs |
| --- | --- | --- |
| B1 | Vihje | Järgmine valik |
| B2 | Võta käik tagasi (ilma mänguta: uus mäng) | Vali või muuda |
| B3 | Ava menüü | Sulge menüü |

Menüüs on uus mäng, vastane (Claude, arvuti, inimene), raskusaste, sinu värv ja praeguse mängu kordus. Pärast uut mängu või tagasivõttu näitavad LED-id, kuhu nupp panna ja kust ära võtta, kuni laud on õiges seisus. Tammiks saamisel kuvab LCD "Tamm! Pane kroon peale".

## Ruudud ja laua bitid

Laud saadab 32-bitise maski, kus bitt `i` = 1 tähendab, et ruudul `i` on nupp.

| MCP23017 | Port | Bitid | Ruudud |
| --- | --- | --- | --- |
| #1 (0x20) | GPA0–7 | 0–7 | a1 c1 e1 g1 b2 d2 f2 h2 |
| #1 (0x20) | GPB0–7 | 8–15 | a3 c3 e3 g3 b4 d4 f4 h4 |
| #2 (0x21) | GPA0–7 | 16–23 | a5 c5 e5 g5 b6 d6 f6 h6 |
| #2 (0x21) | GPB0–7 | 24–31 | a7 c7 e7 g7 b8 d8 f8 h8 |

Reed-lülitid on ühendatud GND-ga (aktiivne madal), seega peab püsivara MCP väärtused enne saatmist inverteerima: `mask = ~((B2 << 24) | (A2 << 16) | (B1 << 8) | A1)`.

## Käikude tekst

Lihtkäik kirjutatakse kujul `c3-d4` ja löömine kujul `d4:f6:d8`. Löömise vahepealsed ruudud võib ära jätta (`d4:d8`), kui käik jääb üheselt mõistetavaks.
