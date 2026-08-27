import { getJsonBody, handleError, sendJson, suggestRecipes } from './_pantry.mjs';

export default async function handler(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed.' });
  try {
    const body = await getJsonBody(req);
    return sendJson(res, 200, await suggestRecipes(body.ingredients, String(body.preference || '').slice(0, 240)));
  } catch (error) {
    return handleError(res, error);
  }
}
