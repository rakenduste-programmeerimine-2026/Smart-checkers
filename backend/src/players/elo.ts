/**
 * Elo-reiting. Uus mängija alustab 1200-st. Esimese 10 mängu jooksul muutub
 * reiting kiiremini (K = 40), seejärel K = 24.
 */
export const START_RATING = 1200;
export const PROVISIONAL_GAMES = 10;
export const K_PROVISIONAL = 40;
export const K_DEFAULT = 24;

/** Tõenäosus, et A võidab B-d (0–1). */
export function expectedScore(ratingA: number, ratingB: number): number {
  return 1 / (1 + 10 ** ((ratingB - ratingA) / 400));
}

/** Uus reiting. score: 1 = võit, 0.5 = viik, 0 = kaotus. */
export function newRating(rating: number, opponent: number, score: number, gamesPlayed: number): number {
  const k = gamesPlayed < PROVISIONAL_GAMES ? K_PROVISIONAL : K_DEFAULT;
  return Math.round(rating + k * (score - expectedScore(rating, opponent)));
}

/** Arvuti vastaste püsireitingud (ligikaudsed, et võidud tugevama vastu loeksid rohkem). */
export const AI_RATINGS = {
  engine: { beginner: 800, medium: 1200, strong: 1600 },
  claude: { beginner: 1000, medium: 1400, strong: 1700 },
} as const;

/** Tiitel reitingu järgi (kuvamiseks äpis ja laual). */
export function rankTitle(rating: number): string {
  if (rating >= 1800) return 'Meister';
  if (rating >= 1500) return 'Ekspert';
  if (rating >= 1300) return 'Edasijõudnu';
  if (rating >= 1100) return 'Harrastaja';
  return 'Algaja';
}
