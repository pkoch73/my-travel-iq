import { Hono } from 'hono';

const app = new Hono();

const COLORS = ['#3B82F6', '#EF4444', '#10B981', '#F59E0B', '#8B5CF6', '#EC4899', '#06B6D4', '#F97316'];

// List travelers for the current user
app.get('/', async (c) => {
  const user = c.get('user');
  const { results } = await c.env.DB.prepare(
    'SELECT * FROM travelers WHERE user_id = ? ORDER BY is_primary DESC, name ASC'
  ).bind(user.id).all();
  return c.json(results);
});

// Create a traveler
app.post('/', async (c) => {
  const user = c.get('user');
  const body = await c.req.json();
  const id = crypto.randomUUID();

  // Pick a color based on how many travelers exist
  const { count } = await c.env.DB.prepare(
    'SELECT COUNT(*) as count FROM travelers WHERE user_id = ?'
  ).bind(user.id).first();
  const color = body.color || COLORS[count % COLORS.length];

  await c.env.DB.prepare(
    'INSERT INTO travelers (id, user_id, name, color, is_primary) VALUES (?, ?, ?, ?, ?)'
  ).bind(id, user.id, body.name, color, body.is_primary ? 1 : 0).run();
  return c.json({ id, name: body.name, color }, 201);
});

// Update a traveler
app.put('/:id', async (c) => {
  const user = c.get('user');
  const travelerId = c.req.param('id');
  const body = await c.req.json();

  const existing = await c.env.DB.prepare(
    'SELECT id FROM travelers WHERE id = ? AND user_id = ?'
  ).bind(travelerId, user.id).first();
  if (!existing) return c.json({ error: 'Not found' }, 404);

  await c.env.DB.prepare(
    'UPDATE travelers SET name = ?, color = ? WHERE id = ?'
  ).bind(body.name, body.color, travelerId).run();
  return c.json({ ok: true });
});

// Delete a traveler
app.delete('/:id', async (c) => {
  const user = c.get('user');
  const travelerId = c.req.param('id');

  const existing = await c.env.DB.prepare(
    'SELECT id FROM travelers WHERE id = ? AND user_id = ?'
  ).bind(travelerId, user.id).first();
  if (!existing) return c.json({ error: 'Not found' }, 404);

  await c.env.DB.prepare('DELETE FROM travelers WHERE id = ?').bind(travelerId).run();
  return c.json({ ok: true });
});

export { app as travelersRoutes };
