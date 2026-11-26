# Smart-checkers

Nutika kabelaua mänguserver. Laud (Arduino UNO R4 WiFi, 32 reed-lülitit, LED-riba, LCD) ja iOS äpp (Expo) räägivad selle serveriga, mis hoiab kabe reegleid, AI vastast ning API-t äpile ja lauale.

## Mis siin praegu on

- `src/game/squares.ts`: tumedate ruutude numeratsioon 0–31, mis vastab laua reed-lülitite bittidele.
- `src/game/rules.ts`: kabe (vene kabe) reeglid, mis hõlmavad kohustuslikku löömist, lendavat tammi, türgi löögi keeldu, tammiks saamist löömise ajal ning võitu ja viiki. Viik tuleb 15 käigu järel ainult tammidega ilma löömiseta, kui sama seis kordub kolmandat korda, või kui 3+ tammi ei võida üksikut tammi 15 käiguga.
- `src/game/sensors.ts`: laua 32-bitise hõivatusmaski tõlgendamine käiguks.
- `src/ai/engine.ts`: kohalik AI mootor (negamax alfa-beeta kärpimisega). Tasemed on `beginner` (2 poolkäiku, teeb vahel vigu), `medium` (4 poolkäiku) ja `strong` (7 poolkäiku). Otsing süveneb järk-järgult ja mõtleb kõige rohkem 1 sekundi; kui aeg saab otsa, kasutatakse viimast lõpetatud sügavust. Lisaks on `suggestMove` vihje andmiseks.
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

### Docker

```bash
cd backend
docker compose up -d          # ehitab ja käivitab, andmed köites kabe-data
# või ilma compose'ita:
docker build -t smart-checkers .
docker run -p 3000:3000 -v kabe-data:/data -e API_TOKEN=... -e BOARD_TOKEN=... smart-checkers
```

Konteiner töötab tavakasutajana (`node`), salvestab mängud ja mängijad kausta `/data` ning kontrollib ise oma tervist (`/health`). Võtmed pane faili `backend/.env`, mida gitti ei panda. CI ehitab konteineri igas PR-is ja kontrollib, et see käivitub.

### Keskkonnamuutujad

| Muutuja | Vaikimisi | Tähendus |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | – | Claude API võti välise AI vastase jaoks. Ilma selleta mängib kohalik mootor. |
| `AI_MODEL` | `claude-opus-5-5` | Claude mudel |
| `DATA_DIR` | `data` | Kaust, kuhu mängud JSON-failidena salvestatakse |
| `API_TOKEN` | – | Äpi ligipääsuvõti (vähemalt 16 märki) |
| `BOARD_TOKEN` | – | Laua ligipääsuvõti (vähemalt 16 märki) |
| `RATE_LIMIT_PER_MIN` | `300` | Tavaliste päringute limiit IP kohta minutis |
| `AI_RATE_LIMIT_PER_MIN` | `30` | AI-d käivitavate päringute limiit IP kohta minutis |
| `TRUST_PROXY` | – | `true`, kui server on pöördproksi taga (siis loetakse IP päisest `X-Forwarded-For`) |
| `PORT` | `3000` | Serveri port |
| `HOST` | `0.0.0.0` | Kuulatav aadress (laud ja telefon on samas võrgus) |

## Turvalisus

- **Ligipääsuvõtmed.** Kui `API_TOKEN` on seatud, peab äpp saatma päise `Authorization: Bearer <API_TOKEN>`. Laud saadab `Authorization: Bearer <BOARD_TOKEN>` ja selle võtmega pääseb ainult laua olekupäringule (`POST /api/board/:boardId/state`), mitte mängude haldusele. Võtmeid võrreldakse konstantse ajaga. Ilma võtmeteta on server avatud ja hoiatab selle eest käivitumisel. `/health` on alati avalik.
- **Päringulimiit** IP kaupa minutiaknaga: tavalised päringud 300, laua olekupäringud 900 ja AI-d käivitavad päringud (uus mäng, käik, `/api/ai/move`) 30 minutis. Üle limiidi tuleb vastus 429 koos päisega `Retry-After`.
- **Claude API kulu.** Korraga käib kuni 4 Claude päringut, ülejäänud käigud teeb kohalik mootor.
- **Sisendi piirid.** Keha on kuni 256 KB, PDN kuni 100 000 märki, käikude nimekiri kuni 500 käiku, laua id kuni 32 märki ja korraga on kuni 16 lauda. Kõik kehad kontrollitakse zod skeemiga.
- **Failid.** Mängu id kontrollitakse enne failiteeks tegemist, nii et `../` ei pääse andmekaustast välja. Fail kirjutatakse ajutisse faili ja nimetatakse siis ümber.
- **Vead.** Serveri vigade (500) üksikasju kliendile ei näidata, need lähevad logisse. Vastustel on päised `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Content-Security-Policy`, `Referrer-Policy` ja `Cache-Control: no-store`.

CORS päiseid server ei saada, sest äpp (Expo) ja laud ei ole brauserid.

## REST API

Täielik kirjeldus on OpenAPI 3.1 kujul: `GET /api/openapi.json` (võtmeta). Ava see näiteks [Swagger Editoris](https://editor.swagger.io) või impordi Postmani. Test kontrollib, et iga serveri tee on dokumendis kirjas.

Kõik vastused on JSON-is. Vead tulevad kujul `{ "error": "..." }` ja koodiga 400 (vigane sisend), 404 (mängu pole), 409 (pole sinu kord või mäng on läbi) või 422 (ebaseaduslik käik).

| Meetod | Tee | Keha | Vastus |
| --- | --- | --- | --- |
| `GET` | `/health` | – | `{ status: "ok" }` |
| `POST` | `/api/games` | `{ opponent?: "claude" \| "engine" \| "none", level?: "beginner" \| "medium" \| "strong", humanColor?: "white" \| "black", clockMinutes?: 0–180 }` | `{ game, aiMove }` (AI alustab, kui inimene on must) |
| `GET` | `/api/games?limit=50` | – | `{ games: [{ id, meta, moveCount, result, endedAt? }] }` (uuemad eespool, ka kettal olevad) |
| `GET` | `/api/games/:id` | – | `{ game }` (mälust või kettalt) |
| `GET` | `/api/games/:id/pdn` | – | PDN-fail (vene kabe, GameType 25) |
| `POST` | `/api/games/import` | `{ pdn: "..." }` | `{ game }` (kahe inimese mänguks) |
| `DELETE` | `/api/games/:id` | – | 204 |
| `POST` | `/api/games/:id/moves` | `{ move: "c3-d4", expectedPly?: 0 }` | `{ game, aiMove, duplicate? }` (AI vastukäik kohe sama vastusega) |
| `POST` | `/api/games/:id/hint` | – | `{ hint: "c3-d4", detail: { from, path, captures } }` |
| `POST` | `/api/games/:id/undo` | `{ expectedPly? }` | `{ game, undone }` (inimese viimane käik ja AI vastus) |
| `POST` | `/api/games/:id/resign` | `{ color? }` | `{ game }` (arvuti vastu alistub inimene) |
| `POST` | `/api/games/:id/draw` | `{ action?: "offer" \| "decline", color? }` | `{ status: "accepted" \| "declined" \| "pending", game }` |
| `GET` | `/api/games/:id/review` | – | `{ review: { moves, summary, keyMoments } }` (mänguülevaade) |
| `GET` | `/api/games/:id/analysis?level=medium&top=3` | – | `{ analysis: { score, summary, depth, bestMoves } }` |
| `GET` | `/api/games/:id/events` | – | Server-Sent Events: sündmus `game` iga muutuse korral |
| `POST` | `/api/ai/move` | `{ moves: ["c3-d4", ...], opponent?, level? }` | `{ position, aiMove }` (olekuta: käigud algusest) |

`game` sisaldab välju `id`, `opponent`, `level`, `humanColor`, `turn`, `pieces` (`[{ square, color, king }]`), `legalMoves`, `history`, `ply` (käikude arv), `lastMove` (viimane käik ruutudega, et äpp saaks selle esile tõsta), `aiThinking`, `drawOffer`, `canUndo`, `clock` ja `result`. `result` on `ongoing`, `win` koos `winner` ja `reason`-iga (`no-moves`, `time`, `resign`) või `draw` koos `reason`-iga (`king-moves`, `repetition`, `lone-king`, `agreement`).

### Töökindlus äpi jaoks

- **Ohutu kordus.** Saada käigu ja tagasivõtu juures `expectedPly` (mängu `ply` sinu teada). Kui vastus läks võrgus kaduma ja äpp saadab sama käigu uuesti, ei tehta seda teist korda: vastus on sama koos `duplicate: true`. Kui seis on vahepeal muutunud (näiteks käidi laual), tuleb 409 koos `stale: true` ja praeguse `game`-iga, nii et äpp saab kohe värskendada.
- **Otseuuendused.** `GET /api/games/:id/events` hoiab ühenduse lahti ja saadab sündmuse `game` (`{ game, aiMove }`) iga muutuse korral: käik äpis või laual, AI hakkab mõtlema, AI käis, tagasivõtt, mängu lõpp. Nii ei pea äpp serverit pidevalt küsitlema. Ühendus saadab iga 15 s `: ping`, et võrk seda kinni ei paneks. Expos sobib näiteks `react-native-sse`, mis lubab saata ka `Authorization` päise. Ühe mängu kohta on lubatud kuni 20 ühendust.
- **Viigipakkumine.** Arvuti vastu vastab AI kohe: nõustub, kui seis pole tema jaoks selgelt parem. Kahe inimese mängus jääb pakkumine (`drawOffer`) ootele, kuni teine pool nõustub (`offer`) või keeldub (`decline`), ja kaob järgmise käiguga.
- **Mänguülevaade.** `GET /api/games/:id/review` hindab iga käiku: `best`, `good`, `inaccuracy`, `mistake`, `blunder` või `forced` (ainus käik), koos parema käigu (`best`) ja kaotusega sentinuppudes (`loss`). `summary` annab mõlemale poolele täpsuse (0–100) ja vigade arvu, `keyMoments` kuni 3 suurima veaga käiku. Tulemus jäetakse meelde, kuni mäng muutub. Laual menüüst "Kordus" näitab LCD vea juures "Viga! e3-f4" ja parem käik süttib helesinisena.
- **Analüüs.** `score` on valge vaatenurgast (100 = üks lihtnupp), `summary` on lühike eestikeelne tekst ("Väike eelis valgel") ja `bestMoves` parimad käigud koos ruutudega. Analüüs ja vihje kuuluvad AI päringulimiidi alla.

`aiMove` sisaldab välju `move`, `from`, `path`, `captures`, `promotes`, `source` (`claude` või `engine`), `reason` (AI põhjendus) ja `fallbackReason` (miks kohalik mootor välise AI asemel käis).

### Mängijad ja edetabel

| Meetod | Tee | Keha | Vastus |
| --- | --- | --- | --- |
| `POST` | `/api/players` | `{ name: "Maik" }` | `{ player }` (201; nimi 1–24 märki, unikaalne) |
| `GET` | `/api/players?limit=50` | – | `{ players: [{ rank, id, name, rating, bestRating, title, stats }] }` (edetabel) |
| `GET` | `/api/players/:id` | – | `{ player }` koos reitingu ajalooga (`history`, viimased 50) |
| `PATCH` | `/api/players/:id` | `{ name }` | `{ player }` |
| `DELETE` | `/api/players/:id` | – | 204 |

Mängu loomisel saab mängijad siduda: `POST /api/games` kehas `players: { white?: id, black?: id }` (arvuti vastu loeb ainult inimese värv). Kui mäng lõpeb, uuendatakse reitingut üks kord (Elo, algus 1200, esimesed 10 mängu K = 40, edasi K = 24). Arvuti vastastel on püsireiting: arvuti 800/1200/1600, Claude 1000/1400/1700 (algaja/keskmine/tugev). Kahe inimese mängus muutub reiting, kui mõlemad on mängijad. Tiitlid: Algaja (< 1100), Harrastaja, Edasijõudnu (1300+), Ekspert (1500+), Meister (1800+). `stats` sisaldab võite, kaotusi, viike, seeriat (`streak`, + võidud, − kaotused) ja tulemusi vastase kaupa (`byOpponent`). Edetabelisse kantud mängu ei saa tagasi võtta. Laua menüüs valib "Mängija" edetabelist, kes laua taga mängib. Mängijad salvestatakse faili `DATA_DIR/players.data`.

### Kabeülesanded

| Meetod | Tee | Keha | Vastus |
| --- | --- | --- | --- |
| `GET` | `/api/puzzles` | – | `{ puzzles: [{ id, title, difficulty, turn, source }] }` |
| `GET` | `/api/puzzles/:id` | – | `{ puzzle }` koos nuppude ja seaduslike käikudega (lahenduseta) |
| `POST` | `/api/puzzles/:id/start` | – | `{ game }` (201): mäng ülesande seisust, vastu tugev mootor |
| `POST` | `/api/games/:id/puzzles` | – | `{ puzzles }`: mängu suurematest vigadest tehtud ülesanded |
| `POST` | `/api/board/:boardId/puzzle` | `{ puzzleId }` | `{ board, display }` (201): ülesanne laual |

Kogus on 12 ülesannet (kerge, keskmine, raske), mis on leitud mootoriga ja testis kontrollitud: lahendus on vähemalt ühe nupu võrra parem kui ükski teine käik. Käigu teeb äpp või laud tavalise käiguna (`POST /api/games/:id/moves`). Õige käigu järel on `game.puzzle.state` `solved`, vale käigu järel `failed` ja `solution` näitab õiget käiku. Õigeks loetakse ka teine käik, mida mootor peab sama heaks. Laual valib menüüs "Ülesanne" järgmise ülesande: LED-id näitavad, kuhu nupud panna, LCD ütleb "Leia parim käik", lahendus annab "Lahendatud!" ja vale käik "Vale käik! Õige: …" koos õige käigu LED-idega. Ülesandes vihjet ja tagasivõttu pole. PDN-i ekspordis on ülesande algseis `FEN`-päises.

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

### Laua tervis ja test

`GET /api/board/:boardId/health` annab `{ health: { online, requests, avgIntervalMs, maxGapMs, disconnects, log, sensors: { seen, flickering } } }`. `log` sisaldab viimase 50 ühenduse ja katkestuse aega (katkestus = laud ei küsinud 5 s). `flickering` loetleb ruudud, mille reed-lüliti lülitub kiiresti edasi-tagasi (tõenäoliselt lahti või magnet on piiri peal).

Menüüs "Laua test" lülitab sisse testirežiimi: praegu hõivatud ruut on valge, varem nähtud roheline ja kunagi nähtamatu punane vilkuv. Lükka nupp üle kõigi ruutude ja kontrolli, et kõik läheksid roheliseks. LCD näitab "Andurid 18/32" ja värisevaid lüliteid. B1 süütab kõik LED-id valgelt (LED-riba test), B2 alustab andurite testi uuesti ja B3 väljub.

### Võrgumäng kahe laua vahel

`POST /api/matches` kehaga `{ white: "laud1", black: "laud2", clockMinutes?: 5 }` seob kaks lauda ühe kahe inimese mänguga (201, `{ gameId, boards }`). Kumbki laud mängib ainult oma värviga: oma käik loetakse magnetitest, vastase käik süttib LED-idega (kollane algus, roheline lõpp) ja tuleb laual järele teha. LCD näitab "Sinu kord" või "Vastase kord" ning "Vastane eemal", kui teine laud pole 5 s ühendust võtnud (`board.match.peerOnline`). Menüüst saab pakkuda viiki (teisel laual "Vastane: viik? B2 jah B1 ei") ja alistuda. Võrgumängus tagasivõttu pole. Äpp saab mängu jälgida tavaliste mängu teede ja `/events` kaudu.

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

Menüüs on uus mäng, vastane (Claude, arvuti, inimene), raskusaste, sinu värv, mängija (edetabelist või külaline), male kell, kabeülesanne, laua test (väljas, 5, 10, 15 või 30 minutit), praeguse mängu kordus, viigipakkumine ja alistumine. Kahe inimese mängus laua taga kehtib viik menüüst kohe; arvuti vastu otsustab AI. Mängu lõpus näitab LCD teisel real põhjust (näiteks "Seis kordus 3x" või "Alistumine").

Kellaga mängus näitab LCD teisel real mõlema poole aega (`V 4:32    M 5:00`). Kell käivitub esimese käiguga ja kui aeg saab otsa, võidab vastane. Kui Claude API ei vasta ja käib kohalik mootor, kuvab LCD "Claude ei vasta / Käis arvuti". `GET /api/board/:boardId` näitab väljadega `online` ja `lastSeenAt`, kas laud on võrgus. Pärast uut mängu või tagasivõttu näitavad LED-id, kuhu nupp panna ja kust ära võtta, kuni laud on õiges seisus. Tammiks saamisel kuvab LCD "Tamm! Pane kroon peale".

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
