import { Hono } from 'hono';

const app = new Hono();

// Generate a share link for a trip
app.post('/', async (c) => {
  const user = c.get('user');
  const { trip_id } = await c.req.json();

  // Verify membership
  const membership = await c.env.DB.prepare(
    'SELECT role FROM trip_members WHERE trip_id = ? AND user_id = ?'
  ).bind(trip_id, user.id).first();
  if (!membership) return c.json({ error: 'Trip not found' }, 404);

  const id = crypto.randomUUID();
  // Short token for URL-friendly share links
  const token = crypto.randomUUID().slice(0, 12);

  await c.env.DB.prepare(
    'INSERT INTO shares (id, trip_id, token, created_by) VALUES (?, ?, ?, ?)'
  ).bind(id, trip_id, token, user.id).run();

  return c.json({ id, token }, 201);
});

// List shares for a trip
app.get('/trip/:tripId', async (c) => {
  const user = c.get('user');
  const tripId = c.req.param('tripId');

  // Verify membership
  const membership = await c.env.DB.prepare(
    'SELECT role FROM trip_members WHERE trip_id = ? AND user_id = ?'
  ).bind(tripId, user.id).first();
  if (!membership) return c.json({ error: 'Trip not found' }, 404);

  const { results } = await c.env.DB.prepare(
    'SELECT * FROM shares WHERE trip_id = ? AND is_active = 1 ORDER BY created_at DESC'
  ).bind(tripId).all();

  return c.json(results);
});

// Revoke a share
app.delete('/:id', async (c) => {
  const user = c.get('user');
  const shareId = c.req.param('id');

  // Verify the share exists and user is a member of the trip
  const share = await c.env.DB.prepare('SELECT trip_id FROM shares WHERE id = ?').bind(shareId).first();
  if (!share) return c.json({ error: 'Not found' }, 404);

  const membership = await c.env.DB.prepare(
    'SELECT role FROM trip_members WHERE trip_id = ? AND user_id = ?'
  ).bind(share.trip_id, user.id).first();
  if (!membership) return c.json({ error: 'Not found' }, 404);

  await c.env.DB.prepare(
    'UPDATE shares SET is_active = 0 WHERE id = ?'
  ).bind(shareId).run();

  return c.json({ ok: true });
});

export { app as sharesRoutes };

// Public routes (no auth required)
const publicApp = new Hono();

publicApp.get('/:token', async (c) => {
  const token = c.req.param('token');

  const share = await c.env.DB.prepare(
    'SELECT * FROM shares WHERE token = ? AND is_active = 1'
  ).bind(token).first();
  if (!share) return c.json({ error: 'Share not found or expired' }, 404);

  if (share.expires_at && new Date(share.expires_at) < new Date()) {
    return c.json({ error: 'Share link expired' }, 410);
  }

  // Fetch trip
  const trip = await c.env.DB.prepare('SELECT * FROM trips WHERE id = ?').bind(share.trip_id).first();
  if (!trip) return c.json({ error: 'Trip not found' }, 404);

  // Fetch segments
  const { results: segments } = await c.env.DB.prepare(
    'SELECT * FROM segments WHERE trip_id = ? ORDER BY start_datetime ASC, sort_order ASC'
  ).bind(share.trip_id).all();

  // Fetch traveler links (legacy)
  const { results: travelerLinks } = await c.env.DB.prepare(
    `SELECT st.segment_id, t.id, t.name, t.color FROM segment_travelers st
     JOIN travelers t ON t.id = st.traveler_id
     WHERE st.segment_id IN (SELECT id FROM segments WHERE trip_id = ?)`
  ).bind(share.trip_id).all();

  // Fetch member links
  const { results: memberLinks } = await c.env.DB.prepare(
    `SELECT sm.segment_id, u.id, u.name, u.color, u.picture_url FROM segment_members sm
     JOIN users u ON u.id = sm.user_id
     WHERE sm.segment_id IN (SELECT id FROM segments WHERE trip_id = ?)`
  ).bind(share.trip_id).all();

  const travelersBySegment = {};
  for (const link of travelerLinks) {
    if (!travelersBySegment[link.segment_id]) travelersBySegment[link.segment_id] = [];
    travelersBySegment[link.segment_id].push({ id: link.id, name: link.name, color: link.color });
  }
  for (const link of memberLinks) {
    if (!travelersBySegment[link.segment_id]) travelersBySegment[link.segment_id] = [];
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

  // Get sharer name
  const sharer = await c.env.DB.prepare('SELECT name FROM users WHERE id = ?').bind(share.created_by).first();

  return c.json({
    ...trip,
    segments: enrichedSegments,
    shared_by: sharer?.name || 'Someone'
  });
});

export { publicApp as publicShareRoutes };
