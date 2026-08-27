const maxBodyBytes = 12 * 1024 * 1024;

const responseSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    ingredients: { type: 'array', maxItems: 10, items: { type: 'object', additionalProperties: false, properties: {
      name: { type: 'string' }, amount: { type: 'string' }, confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
      imageFocusX: { type: 'number', minimum: 0, maximum: 100 }, imageFocusY: { type: 'number', minimum: 0, maximum: 100 },
    }, required: ['name', 'amount', 'confidence', 'imageFocusX', 'imageFocusY'] } },
    dish: { type: 'object', additionalProperties: false, properties: {
      name: { type: 'string' }, description: { type: 'string' }, reason: { type: 'string' }, missingIngredients: { type: 'array', items: { type: 'string' } },
    }, required: ['name', 'description', 'reason', 'missingIngredients'] },
  }, required: ['ingredients', 'dish'],
};

const recipeSuggestionSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    message: { type: 'string' },
    recipes: { type: 'array', maxItems: 4, items: { type: 'object', additionalProperties: false, properties: {
      title: { type: 'string' }, time: { type: 'string' }, tag: { type: 'string' }, summary: { type: 'string' }, matchReason: { type: 'string' },
      ingredients: { type: 'array', items: { type: 'string' } }, steps: { type: 'array', items: { type: 'string' } },
    }, required: ['title', 'time', 'tag', 'summary', 'matchReason', 'ingredients', 'steps'] } },
  }, required: ['message', 'recipes'],
};

export function sendJson(res, status, data) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(JSON.stringify(data));
}

export async function getJsonBody(req) {
  // Vercel normally parses JSON before calling the handler. The fallback also
  // makes these functions usable by a plain Node HTTP server in development.
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBodyBytes) throw Object.assign(new Error('The image is too large. Please choose a smaller photo.'), { status: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('The request could not be read.'), { status: 400 }); }
}

function getOutputText(response) {
  if (typeof response.output_text === 'string') return response.output_text;
  return (response.output || []).flatMap(item => item.content || []).filter(item => item.type === 'output_text').map(item => item.text).join('');
}

function requireApiKey() {
  if (!process.env.OPENAI_API_KEY) throw Object.assign(new Error('OpenAI is not configured. Add OPENAI_API_KEY in Vercel Project Settings → Environment Variables, then redeploy.'), { status: 503 });
}

async function callOpenAI(body) {
  const apiResponse = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const responseJson = await apiResponse.json().catch(() => null);
  if (!apiResponse.ok) throw Object.assign(new Error(responseJson?.error?.message || 'OpenAI could not complete this request right now.'), { status: apiResponse.status || 502 });
  return responseJson;
}

export async function analyzePantry(imageData) {
  requireApiKey();
  if (typeof imageData !== 'string' || !/^data:image\/(?:jpeg|png|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(imageData)) {
    throw Object.assign(new Error('Please use a JPG, PNG, WEBP, or GIF photo.'), { status: 400 });
  }
  const response = await callOpenAI({
    model: process.env.OPENAI_MODEL || 'gpt-5.4-mini', store: false, max_output_tokens: 260, reasoning: { effort: 'none' },
    input: [{ role: 'user', content: [
      { type: 'input_text', text: 'Fast visual classification: identify at most 10 visible food ingredients with short, conservative estimates. For each ingredient, return imageFocusX and imageFocusY as the approximate center of that exact visible item in the uploaded image, from 0 to 100 percent left-to-right and top-to-bottom. If an item appears multiple times, use the clearest one. Then suggest one simple dish using them. Keep every field extremely brief; return no ingredients when the image has no usable food.' },
      { type: 'input_image', image_url: imageData, detail: 'low' },
    ] }],
    text: { verbosity: 'low', format: { type: 'json_schema', name: 'pantry_scan', strict: true, schema: responseSchema } },
  });
  try { return JSON.parse(getOutputText(response)); }
  catch { throw Object.assign(new Error('The AI response was incomplete. Please try the photo again.'), { status: 502 }); }
}

export async function suggestRecipes(rawIngredients, preference = '') {
  requireApiKey();
  const ingredients = Array.isArray(rawIngredients) ? rawIngredients.map(item => String(item).trim()).filter(Boolean).slice(0, 40) : [];
  if (!ingredients.length) throw Object.assign(new Error('Add at least one ingredient before finding recipes.'), { status: 400 });
  const response = await callOpenAI({
    model: process.env.OPENAI_MODEL || 'gpt-5.4-mini', store: false, max_output_tokens: 1200, reasoning: { effort: 'none' },
    input: `You are a strict pantry recipe matcher. Available ingredients: ${JSON.stringify(ingredients)}. Preference: ${preference || 'none'}. Return up to four practical dish ideas, ranked by how many required ingredients the user has. Every item in each recipe's ingredients array MUST be an available ingredient (case-insensitive); never add staples, seasonings, water, oil, salt, pepper, or optional ingredients unless explicitly listed. Do not put unavailable ingredients in steps either. If no coherent dish can be made, return an empty recipes list and explain briefly in message. Prefer recipes using the largest number of supplied ingredients.`,
    text: { verbosity: 'low', format: { type: 'json_schema', name: 'pantry_recipes', strict: true, schema: recipeSuggestionSchema } },
  });
  try {
    const result = JSON.parse(getOutputText(response));
    const available = new Set(ingredients.map(item => item.toLocaleLowerCase().trim()));
    result.recipes = result.recipes.filter(recipe => recipe.ingredients.length > 0 && recipe.ingredients.every(item => available.has(item.toLocaleLowerCase().trim())));
    if (!result.recipes.length && !result.message) result.message = 'I could not make a dish using only those ingredients.';
    return result;
  } catch { throw Object.assign(new Error('The AI response was incomplete. Please try again.'), { status: 502 }); }
}

export function handleError(res, error) {
  const status = Number.isInteger(error?.status) ? error.status : 500;
  if (status === 500) console.error('Unhandled API error:', error);
  sendJson(res, status, { error: error?.message || 'Something went wrong. Please try again.' });
}
