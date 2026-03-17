import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { authMiddleware } from './middleware/auth.js';
import { authRoutes } from './routes/auth.js';
import { tripsRoutes } from './routes/trips.js';
import { travelersRoutes } from './routes/travelers.js';
import { segmentsRoutes } from './routes/segments.js';
import { extractRoutes } from './routes/extract.js';
import { sharesRoutes, publicShareRoutes } from './routes/shares.js';
import { membersRoutes } from './routes/members.js';
import { destinationsRoutes } from './routes/destinations.js';

const app = new Hono();

app.use('/api/*', cors());

// --- Auth endpoints (no middleware) ---

// Google OAuth routes
app.route('/api/auth', authRoutes);

// Legacy anonymous registration (kept for migration)
app.post('/api/auth/register', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const id = crypto.randomUUID();
  const token = crypto.randomUUID();

  const colors = ['#22C55E', '#3B82F6', '#EF4444', '#F59E0B', '#8B5CF6', '#0EA5E9', '#EA580C', '#6366F1'];
  const color = colors[Math.floor(Math.random() * colors.length)];

  await c.env.DB.prepare(
    'INSERT INTO users (id, email, name, token, color) VALUES (?, ?, ?, ?, ?)'
  ).bind(id, body.email || null, body.name || '', token, color).run();

  // Auto-create a primary traveler for the user
  const travelerId = crypto.randomUUID();
  await c.env.DB.prepare(
    'INSERT INTO travelers (id, user_id, name, color, is_primary) VALUES (?, ?, ?, ?, 1)'
  ).bind(travelerId, id, body.name || 'Me', color).run();

  return c.json({ token, user: { id, name: body.name || '', email: body.email || null } }, 201);
});

app.get('/api/auth/me', authMiddleware, async (c) => {
  return c.json(c.get('user'));
});

// --- Public shared trip view (no auth) ---
app.route('/api/shared', publicShareRoutes);

// --- Protected API routes ---
app.use('/api/*', authMiddleware);
app.route('/api/trips', tripsRoutes);
app.route('/api/trips', membersRoutes);  // /api/trips/:tripId/members/*
app.route('/api/travelers', travelersRoutes);
app.route('/api/segments', segmentsRoutes);
app.route('/api/extract', extractRoutes);
app.route('/api/shares', sharesRoutes);
app.route('/api/destinations', destinationsRoutes);

export default app;
