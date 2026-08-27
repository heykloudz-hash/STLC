import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || '0.0.0.0';
const maxBodyBytes = 12 * 1024 * 1024;
const staticFiles = new Map([
  ['/', 'index.html'],
  ['/index.html', 'index.html'],
  ['/styles.css', 'styles.css'],
  ['/app.js', 'app.js'],
]);
const mimeTypes = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };

const responseSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ingredients: {
      type: 'array',
      maxItems: 10,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string' },
          amount: { type: 'string' },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
          imageFocusX: { type: 'number', minimum: 0, maximum: 100 },
          imageFocusY: { type: 'number', minimum: 0, maximum: 100 },
        },
        required: ['name', 'amount', 'confidence', 'imageFocusX', 'imageFocusY'],
      },
    },
    dish: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: { type: 'string' },
        description: { type: 'string' },
        reason: { type: 'string' },
        missingIngredients: { type: 'array', items: { type: 'string' } },
      },
      required: ['name', 'description', 'reason', 'missingIngredients'],
    },
  },
  required: ['ingredients', 'dish'],
};

const recipeSuggestionSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    message: { type: 'string' },
    recipes: {
      type: 'array', maxItems: 4,
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          title: { type: 'string' }, time: { type: 'string' }, tag: { type: 'string' },
          summary: { type: 'string' }, matchReason: { type: 'string' },
          ingredients: { type: 'array', items: { type: 'string' } },
          steps: { type: 'array', items: { type: 'string' } },
        },
        required: ['title', 'time', 'tag', 'summary', 'matchReason', 'ingredients', 'steps'],
      },
    },
  }, required: ['message', 'recipes'],
};

function sendJson(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(data));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > maxBodyBytes) {
        reject(Object.assign(new Error('The image is too large. Please choose a smaller photo.'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('The photo request could not be read.'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function getOutputText(response) {
  if (typeof response.output_text === 'string') return response.output_text;
  return (response.output || [])
    .flatMap(item => item.content || [])
    .filter(item => item.type === 'output_text')
    .map(item => item.text)
    .join('');
}

function validateImageData(imageData) {
  if (typeof imageData !== 'string' || !/^data:image\/(?:jpeg|png|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(imageData)) {
    throw Object.assign(new Error('Please use a JPG, PNG, WEBP, or GIF photo.'), { status: 400 });
  }
}

async function analyzePantry(imageData) {
  if (!process.env.OPENAI_API_KEY) {
    throw Object.assign(new Error('OpenAI is not configured yet. Add OPENAI_API_KEY to your .env file and restart the server.'), { status: 503 });
  }

  const apiResponse = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || 'gpt-5.4-mini',
      store: false,
      max_output_tokens: 260,
      reasoning: { effort: 'none' },
      input: [{
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: 'Fast visual classification: identify at most 10 visible food ingredients with short, conservative estimates. For each ingredient, return imageFocusX and imageFocusY as the approximate center of that exact visible item in the uploaded image, from 0 to 100 percent left-to-right and top-to-bottom. If an item appears multiple times, use the clearest one. Then suggest one simple dish using them. Keep every field extremely brief; return no ingredients when the image has no usable food.',
          },
          { type: 'input_image', image_url: imageData, detail: 'low' },
        ],
      }],
      text: {
        verbosity: 'low',
        format: {
          type: 'json_schema',
          name: 'pantry_scan',
          strict: true,
          schema: responseSchema,
        },
      },
    }),
  });

  const responseJson = await apiResponse.json();
  if (!apiResponse.ok) {
    const message = responseJson?.error?.message || 'OpenAI could not analyze this photo right now.';
    throw Object.assign(new Error(message), { status: apiResponse.status });
  }

  try {
    return JSON.parse(getOutputText(responseJson));
  } catch {
    throw Object.assign(new Error('The AI response was incomplete. Please try the photo again.'), { status: 502 });
  }
}

async function suggestRecipes(ingredients, preference = '') {
  if (!process.env.OPENAI_API_KEY) {
    throw Object.assign(new Error('OpenAI is not configured yet. Add OPENAI_API_KEY to your .env file and restart the server.'), { status: 503 });
  }
  const apiResponse = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST', headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || 'gpt-5.4-mini', store: false, max_output_tokens: 1200,
      reasoning: { effort: 'none' },
      input: `You are a strict pantry recipe matcher. Available ingredients: ${JSON.stringify(ingredients)}. Preference: ${preference || 'none'}.
Return up to four practical dish ideas, ranked by how many of their required ingredients the user has. Every item in each recipe's ingredients array MUST be an available ingredient (case-insensitive); never add staples, seasonings, water, oil, salt, pepper, or optional ingredients unless they are explicitly in the list. Do not put unavailable ingredients in steps either. If no coherent dish can be made, return an empty recipes list and explain briefly in message. Prefer recipes that use the largest number of supplied ingredients. Amounts are not required; use the ingredient names exactly as supplied where possible.`,
      text: { verbosity: 'low', format: { type: 'json_schema', name: 'pantry_recipes', strict: true, schema: recipeSuggestionSchema } },
    }),
  });
  const responseJson = await apiResponse.json();
  if (!apiResponse.ok) throw Object.assign(new Error(responseJson?.error?.message || 'OpenAI could not suggest recipes right now.'), { status: apiResponse.status });
  try {
    const result = JSON.parse(getOutputText(responseJson));
    const available = new Set(ingredients.map(item => item.toLocaleLowerCase().trim()));
    result.recipes = result.recipes.filter(recipe => recipe.ingredients.length > 0 && recipe.ingredients.every(item => available.has(item.toLocaleLowerCase().trim())));
    if (!result.recipes.length && !result.message) result.message = 'I could not make a dish using only those ingredients.';
    return result;
  }
  catch { throw Object.assign(new Error('The AI response was incomplete. Please try again.'), { status: 502 }); }
}

async function serveStatic(res, pathname) {
  const file = staticFiles.get(pathname);
  if (!file) return false;
  const filePath = join(root, file);
  const body = await readFile(filePath);
  res.writeHead(200, {
    'Content-Type': mimeTypes[extname(file)] || 'application/octet-stream',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
  return true;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  try {
    if (req.method === 'POST' && url.pathname === '/api/analyze-pantry') {
      const body = await readJsonBody(req);
      validateImageData(body.imageData);
      const analysis = await analyzePantry(body.imageData);
      sendJson(res, 200, analysis);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/suggest-recipes') {
      const body = await readJsonBody(req);
      const ingredients = Array.isArray(body.ingredients) ? body.ingredients.map(item => String(item).trim()).filter(Boolean).slice(0, 40) : [];
      if (!ingredients.length) throw Object.assign(new Error('Add at least one ingredient before finding recipes.'), { status: 400 });
      sendJson(res, 200, await suggestRecipes(ingredients, String(body.preference || '').slice(0, 240)));
      return;
    }

    if (req.method === 'GET' && await serveStatic(res, url.pathname)) return;
    sendJson(res, 404, { error: 'Not found.' });
  } catch (error) {
    const status = Number.isInteger(error.status) ? error.status : 500;
    if (status === 500) console.error(error);
    sendJson(res, status, { error: error.message || 'Something went wrong. Please try again.' });
  }
});

server.listen(port, host, () => {
  console.log(`MakeAdish is running at http://localhost:${port}`);
});
