# Muudatuste logi

Vorming: [Keep a Changelog](https://keepachangelog.com/et/1.1.0/), versioonid [SemVer](https://semver.org/lang/et/) järgi.

## [0.1.0] – ootel

Esimene väljalase: mänguserver nutikale kabelauale (vene kabe).

### Lisatud
- Vene kabe reeglid: kohustuslik löömine, lendav tamm, türgi löögi keeld, viigid (15 tammikäiku, kolmekordne kordus, 3 tammi vs 1, kokkulepe).
- AI vastane: kohalik mootor (3 taset, mõtlemisaeg kuni 1 s) ja Claude API koos varumootoriga.
- REST API mängudele: käigud, ohutu kordus (`expectedPly`), tagasivõtt, vihje, alistumine, viigipakkumine, analüüs, otseuuendused (SSE).
- Laua ühendus: reed-lülitite mask → käik, LED-id ja LCD, menüü, male kell, kordus, laua test ja tervise logi.
- Mängude salvestus JSON-failidesse, PDN eksport ja import.
- Mänguülevaade: vead, täpsus ja paremad käigud, ka laual.
- Mängijad, Elo-reiting, statistika ja edetabel.
- Kabeülesanded (12 + mängija enda vigadest), ka laual.
- Võrgumäng kahe laua vahel.
- Turvalisus: ligipääsuvõtmed, päringulimiidid, turvapäised.
- OpenAPI kirjeldus (`/api/openapi.json`), Dockerfile ja docker-compose.
