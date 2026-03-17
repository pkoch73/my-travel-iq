import { Hono } from 'hono';

const app = new Hono();

// List all trips the current user is a member of
app.get('/', async (c) => {
  const user = c.get('user');
  const { results } = await c.env.DB.prepare(
    `SELECT t.*,
       tm.role as my_role,
       (SELECT COUNT(*) FROM segments s WHERE s.trip_id = t.id) as segment_count
     FROM trips t
     JOIN trip_members tm ON tm.trip_id = t.id
     WHERE tm.user_id = ? ORDER BY t.start_date ASC`
  ).bind(user.id).all();
  return c.json(results);
});

// Create a trip
app.post('/', async (c) => {
  const user = c.get('user');
  const body = await c.req.json();
  const id = crypto.randomUUID();
  await c.env.DB.prepare(
    `INSERT INTO trips (id, user_id, name, description, start_date, end_date)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(id, user.id, body.name, body.description || '', body.start_date || null, body.end_date || null).run();

  // Add creator as owner in trip_members
  await c.env.DB.prepare(
    'INSERT INTO trip_members (trip_id, user_id, role) VALUES (?, ?, \'owner\')'
  ).bind(id, user.id).run();

  return c.json({ id, name: body.name }, 201);
});

// Get a single trip with segments and members
app.get('/:id', async (c) => {
  const user = c.get('user');
  const tripId = c.req.param('id');

  // Check membership
  const membership = await c.env.DB.prepare(
    'SELECT role FROM trip_members WHERE trip_id = ? AND user_id = ?'
  ).bind(tripId, user.id).first();
  if (!membership) return c.json({ error: 'Not found' }, 404);

  const trip = await c.env.DB.prepare('SELECT * FROM trips WHERE id = ?').bind(tripId).first();
  if (!trip) return c.json({ error: 'Not found' }, 404);

  const { results: segments } = await c.env.DB.prepare(
    `SELECT * FROM segments WHERE trip_id = ?
     ORDER BY start_datetime ASC, sort_order ASC`
  ).bind(tripId).all();

  // Fetch traveler links (legacy)
  const { results: travelerLinks } = await c.env.DB.prepare(
    `SELECT st.segment_id, t.id, t.name, t.color FROM segment_travelers st
     JOIN travelers t ON t.id = st.traveler_id
     WHERE st.segment_id IN (SELECT id FROM segments WHERE trip_id = ?)`
  ).bind(tripId).all();

  // Fetch member links
  const { results: memberLinks } = await c.env.DB.prepare(
    `SELECT sm.segment_id, u.id, u.name, u.color, u.picture_url FROM segment_members sm
     JOIN users u ON u.id = sm.user_id
     WHERE sm.segment_id IN (SELECT id FROM segments WHERE trip_id = ?)`
  ).bind(tripId).all();

  // Group by segment — combine travelers and members
  const travelersBySegment = {};
  for (const link of travelerLinks) {
    if (!travelersBySegment[link.segment_id]) travelersBySegment[link.segment_id] = [];
    travelersBySegment[link.segment_id].push({ id: link.id, name: link.name, color: link.color });
  }
  for (const link of memberLinks) {
    if (!travelersBySegment[link.segment_id]) travelersBySegment[link.segment_id] = [];
    // Avoid duplicates if somehow both tables have the same person
    const exists = travelersBySegment[link.segment_id].some(t => t.id === link.id);
    if (!exists) {
      travelersBySegment[link.segment_id].push({
        id: link.id, name: link.name, color: link.color, picture_url: link.picture_url
      });
    }
  }

  const enrichedSegments = segments.map(seg => ({
    ...seg,
    details: JSON.parse(seg.details || '{}'),
    travelers: travelersBySegment[seg.id] || []
  }));

  return c.json({ ...trip, my_role: membership.role, segments: enrichedSegments });
});

// Update a trip
app.put('/:id', async (c) => {
  const user = c.get('user');
  const tripId = c.req.param('id');
  const body = await c.req.json();

  // Any member can edit (full collaboration)
  const membership = await c.env.DB.prepare(
    'SELECT role FROM trip_members WHERE trip_id = ? AND user_id = ?'
  ).bind(tripId, user.id).first();
  if (!membership) return c.json({ error: 'Not found' }, 404);

  await c.env.DB.prepare(
    `UPDATE trips SET name = ?, description = ?, start_date = ?, end_date = ?,
     updated_at = datetime('now') WHERE id = ?`
  ).bind(body.name, body.description || '', body.start_date || null, body.end_date || null, tripId).run();
  return c.json({ ok: true });
});

// Delete a trip (owner only)
app.delete('/:id', async (c) => {
  const user = c.get('user');
  const tripId = c.req.param('id');

  const membership = await c.env.DB.prepare(
    'SELECT role FROM trip_members WHERE trip_id = ? AND user_id = ?'
  ).bind(tripId, user.id).first();
  if (!membership) return c.json({ error: 'Not found' }, 404);
  if (membership.role !== 'owner') return c.json({ error: 'Only the trip owner can delete' }, 403);

  await c.env.DB.prepare('DELETE FROM trips WHERE id = ?').bind(tripId).run();
  return c.json({ ok: true });
});

export { app as tripsRoutes };
