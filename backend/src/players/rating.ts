/** Lõppenud mängu tulemuste arvutamine edetabeli jaoks. */
import type { Color, GameResult } from '../game/types.js';
import type { Game } from '../server/games.js';
import { AI_RATINGS } from './elo.js';
import type { Outcome, PlayerStore, RatedResult } from './store.js';

const outcomeFor = (color: Color, result: GameResult): Outcome =>
  result.status === 'draw' ? 'draw' : result.status === 'win' && result.winner === color ? 'win' : 'loss';

/**
 * Arvuti vastu: inimese tulemus arvuti püsireitingu vastu.
 * Kahe inimese vahel: mõlemad, kui mõlemad on edetabelis.
 */
export function ratedResults(game: Game, result: GameResult, players: PlayerStore, at: string): RatedResult[] {
  if (result.status === 'ongoing') return [];
  if (game.opponent) {
    const playerId = game.players[game.humanColor];
    if (!playerId) return [];
    return [
      {
        playerId,
        opponentRating: AI_RATINGS[game.opponent][game.level],
        opponentKey: `${game.opponent}:${game.level}`,
        outcome: outcomeFor(game.humanColor, result),
        gameId: game.id,
        at,
      },
    ];
  }
  const white = game.players.white ? players.peek(game.players.white) : undefined;
  const black = game.players.black ? players.peek(game.players.black) : undefined;
  if (!white || !black || white.id === black.id) return [];
  return (['white', 'black'] as const).map((color) => {
    const me = color === 'white' ? white : black;
    const them = color === 'white' ? black : white;
    return { playerId: me.id, opponentRating: them.rating, opponentKey: 'human', outcome: outcomeFor(color, result), gameId: game.id, at };
  });
}


