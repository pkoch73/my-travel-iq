import { Hono } from 'hono';

const app = new Hono();

// Helper: verify user is a member of the trip
async function verifyTripMembership(db, tripId, userId) {
  return db.prepare(
    'SELECT role FROM trip_members WHERE trip_id = ? AND user_id = ?'
  ).bind(tripId, userId).first();
}

// Create a segment
app.post('/', async (c) => {
  const user = c.get('user');
  const body = await c.req.json();

  // Verify trip membership
  const membership = await verifyTripMembership(c.env.DB, body.trip_id, user.id);
  if (!membership) return c.json({ error: 'Trip not found' }, 404);

  const id = crypto.randomUUID();
  await c.env.DB.prepare(
    `INSERT INTO segments (id, trip_id, type, title, start_datetime, end_datetime, timezone,
     start_location, end_location, confirmation_number, provider, booking_reference,
     details, notes, sort_order, raw_input_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    id, body.trip_id, body.type, body.title || '',
    body.start_datetime || null, body.end_datetime || null, body.timezone || 'UTC',
    body.start_location || '', body.end_location || '',
    body.confirmation_number || '', body.provider || '', body.booking_reference || '',
    JSON.stringify(body.details || {}), body.notes || '',
    body.sort_order || 0, body.raw_input_id || null
  ).run();

  // Assign travelers if provided (legacy)
  if (body.traveler_ids && body.traveler_ids.length > 0) {
    const stmt = c.env.DB.prepare(
      'INSERT INTO segment_travelers (segment_id, traveler_id) VALUES (?, ?)'
    );
    await c.env.DB.batch(
      body.traveler_ids.map(tid => stmt.bind(id, tid))
    );
  }

  // Assign members if provided
  if (body.member_ids && body.member_ids.length > 0) {
    const stmt = c.env.DB.prepare(
      'INSERT INTO segment_members (segment_id, user_id) VALUES (?, ?)'
    );
    await c.env.DB.batch(
      body.member_ids.map(uid => stmt.bind(id, uid))
    );
  }

  // Auto-update trip date range
  await updateTripDates(c.env.DB, body.trip_id);

  return c.json({ id }, 201);
});

// Update a segment
app.put('/:id', async (c) => {
  const user = c.get('user');
  const segmentId = c.req.param('id');
  const body = await c.req.json();

  // Verify membership via trip
  const segment = await c.env.DB.prepare(
    'SELECT s.id, s.trip_id FROM segments s WHERE s.id = ?'
  ).bind(segmentId).first();
  if (!segment) return c.json({ error: 'Not found' }, 404);

  const membership = await verifyTripMembership(c.env.DB, segment.trip_id, user.id);
  if (!membership) return c.json({ error: 'Not found' }, 404);

  await c.env.DB.prepare(
    `UPDATE segments SET type = ?, title = ?, start_datetime = ?, end_datetime = ?,
     timezone = ?, start_location = ?, end_location = ?, confirmation_number = ?,
     provider = ?, booking_reference = ?, details = ?, notes = ?,
     sort_order = ?, updated_at = datetime('now') WHERE id = ?`
  ).bind(
    body.type, body.title || '',
    body.start_datetime || null, body.end_datetime || null, body.timezone || 'UTC',
    body.start_location || '', body.end_location || '',
    body.confirmation_number || '', body.provider || '', body.booking_reference || '',
    JSON.stringify(body.details || {}), body.notes || '',
    body.sort_order || 0, segmentId
  ).run();

  // Update travelers if provided (legacy)
  if (body.traveler_ids) {
    await c.env.DB.prepare('DELETE FROM segment_travelers WHERE segment_id = ?').bind(segmentId).run();
    if (body.traveler_ids.length > 0) {
      const stmt = c.env.DB.prepare(
        'INSERT INTO segment_travelers (segment_id, traveler_id) VALUES (?, ?)'
      );
      await c.env.DB.batch(
        body.traveler_ids.map(tid => stmt.bind(segmentId, tid))
      );
    }
  }

  // Update members if provided
  if (body.member_ids) {
    await c.env.DB.prepare('DELETE FROM segment_members WHERE segment_id = ?').bind(segmentId).run();
    if (body.member_ids.length > 0) {
      const stmt = c.env.DB.prepare(
        'INSERT INTO segment_members (segment_id, user_id) VALUES (?, ?)'
      );
      await c.env.DB.batch(
        body.member_ids.map(uid => stmt.bind(segmentId, uid))
      );
    }
  }

  await updateTripDates(c.env.DB, segment.trip_id);

  return c.json({ ok: true });
});

// Delete a segment
app.delete('/:id', async (c) => {
  const user = c.get('user');
  const segmentId = c.req.param('id');

  const segment = await c.env.DB.prepare(
    'SELECT s.id, s.trip_id FROM segments s WHERE s.id = ?'
  ).bind(segmentId).first();
  if (!segment) return c.json({ error: 'Not found' }, 404);

  const membership = await verifyTripMembership(c.env.DB, segment.trip_id, user.id);
  if (!membership) return c.json({ error: 'Not found' }, 404);

  await c.env.DB.prepare('DELETE FROM segments WHERE id = ?').bind(segmentId).run();
  await updateTripDates(c.env.DB, segment.trip_id);
  return c.json({ ok: true });
});

async function updateTripDates(db, tripId) {
  const range = await db.prepare(
    `SELECT MIN(date(start_datetime)) as min_date, MAX(date(COALESCE(end_datetime, start_datetime))) as max_date
     FROM segments WHERE trip_id = ? AND start_datetime IS NOT NULL`
  ).bind(tripId).first();
  if (range && range.min_date) {
    await db.prepare(
      `UPDATE trips SET start_date = ?, end_date = ?, updated_at = datetime('now') WHERE id = ?`
    ).bind(range.min_date, range.max_date, tripId).run();
  }
}

export { app as segmentsRoutes };
