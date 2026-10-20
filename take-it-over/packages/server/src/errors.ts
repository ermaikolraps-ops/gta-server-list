/** An expected, player-facing rule violation. `code` is stable and translated by the client. */
export class GameError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 409,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export const notFound = (what: string) => new GameError('not_found', `${what} not found`, 404);
export const forbidden = (msg = 'not allowed') => new GameError('forbidden', msg, 403);
export const badRequest = (msg: string, details?: Record<string, unknown>) =>
  new GameError('bad_request', msg, 400, details);
