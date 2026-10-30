import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Upstream API endpoint (kept server-side so the browser never hits it directly)
const UPSTREAM_ENDPOINT = 'https://xalman-apis.vercel.app/api/xnxxsearch';

// Default query if none is provided
const DEFAULT_QUERY = 'Umaasa';

// Simple in-memory cache (30s) to reduce upstream load
const cache = new Map();
const CACHE_TTL_MS = 30_000;

app.use(express.json());
app.disable('x-powered-by');

// Serve static assets from /public
app.use(express.static(path.join(__dirname, 'public'), {
  extensions: ['html'],
  maxAge: '1h',
}));

// Proxy endpoint: GET /api/search?q=...
app.get('/api/search', async (req, res) => {
  const rawQuery = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  const query = rawQuery || DEFAULT_QUERY;
  const cacheKey = query.toLowerCase();

  // Serve from cache if fresh
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return res.json(cached.data);
  }

  // Timeout the upstream request
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 20_000);

  try {
    const upstreamUrl = `${UPSTREAM_ENDPOINT}?q=${encodeURIComponent(query)}`;
    const upstreamRes = await fetch(upstreamUrl, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'User-Agent': 'SelovSearchBold/1.0 (+node)',
      },
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!upstreamRes.ok) {
      return res.status(upstreamRes.status).json({
        status: false,
        message: `Upstream API responded with HTTP ${upstreamRes.status}`,
      });
    }

    const data = await upstreamRes.json();

    // Cache the result
    cache.set(cacheKey, { timestamp: Date.now(), data });

    // Keep the cache from growing unbounded
    if (cache.size > 200) {
      const oldestKey = cache.keys().next().value;
      cache.delete(oldestKey);
    }

    res.set('Cache-Control', 'public, max-age=30');
    res.json(data);
  } catch (error) {
    clearTimeout(timeoutId);

    if (error.name === 'AbortError') {
      return res.status(504).json({
        status: false,
        message: 'Upstream API timed out after 20 seconds.',
      });
    }

    console.error('Upstream fetch error:', error);
    return res.status(502).json({
      status: false,
      message: 'Could not reach upstream API.',
    });
  }
});

// Health check
app.get('/health', (_req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

// SPA fallback — always serve the age-gated index
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Selov Search Bold running at http://localhost:${PORT}`);
});
