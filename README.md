# Smart-checkers

Nutika kabelaua mänguserver. Laud (Arduino UNO R4 WiFi, 32 reed-lülitit, LED-riba, LCD) ja iOS äpp (Expo) räägivad selle serveriga, mis hoiab kabe reegleid ja hiljem ka AI vastast ning API-t.

## Mis siin praegu on

- `src/game/squares.ts`: tumedate ruutude numeratsioon 0–31, mis vastab laua reed-lülitite bittidele.
- `src/game/rules.ts`: kabe (vene kabe) reeglid, mis hõlmavad kohustuslikku löömist, lendavat tammi, türgi löögi keeldu, tammiks saamist löömise ajal ning võitu ja viiki.
- `src/game/sensors.ts`: laua 32-bitise hõivatusmaski tõlgendamine käiguks.

## Käivitamine

```bash
npm install
npm test          # testid (Vitest)
npm run typecheck # TypeScripti kontroll
npm run build     # kompileerib kausta dist/
```

Vaja on Node 20 või uuemat.

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
