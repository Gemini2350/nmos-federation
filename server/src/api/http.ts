import type { FastifyInstance } from 'fastify';
/**
 * A browser's fetch helper typically sets `content-type: application/json` on every
 * request, body or not. Fastify's default parser rejects that with 400
 * FST_ERR_CTP_EMPTY_JSON_BODY — which made every action button in the GUI that posts
 * without a body (Test, Reconcile, Remove leftovers, Re-resolve, Retry, Refresh) fail.
 * An empty JSON body is simply an empty object here.
 */
export function acceptEmptyJson(app: FastifyInstance): void {
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    const text = typeof body === 'string' ? body : body.toString('utf8');
    if (!text.trim()) return done(null, {});
    try {
      done(null, JSON.parse(text));
    } catch (e) {
      const err = e as Error & { statusCode?: number };
      err.statusCode = 400;
      done(err, undefined);
    }
  });
}
