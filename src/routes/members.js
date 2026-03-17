import { Hono } from 'hono';

const app = new Hono();

// List members of a trip
app.get('/:tripId/members', async (c) => {
  const user = c.get('user');
  const tripId = c.req.param('tripId');

  // Verify caller is a member
  const membership = await c.env.DB.prepare(
    'SELECT role FROM trip_members WHERE trip_id = ? AND user_id = ?'
  ).bind(tripId, user.id).first();
  if (!membership) return c.json({ error: 'Not found' }, 404);

  const { results } = await c.env.DB.prepare(
    `SELECT u.id, u.name, u.email, u.picture_url, u.color, tm.role
     FROM trip_members tm
     JOIN users u ON u.id = tm.user_id
     WHERE tm.trip_id = ?
     ORDER BY tm.role DESC, tm.joined_at ASC`
  ).bind(tripId).all();

  return c.json(results);
});

// Join a trip via share token
app.post('/:tripId/members/join', async (c) => {
  const user = c.get('user');
  const tripId = c.req.param('tripId');
  const { share_token } = await c.req.json();

  if (!share_token) {
    return c.json({ error: 'share_token is required' }, 400);
  }

  // Verify share token is valid for this trip
  const share = await c.env.DB.prepare(
    'SELECT id FROM shares WHERE token = ? AND trip_id = ? AND is_active = 1'
  ).bind(share_token, tripId).first();
  if (!share) return c.json({ error: 'Invalid or expired share link' }, 404);

  // Check if already a member
  const existing = await c.env.DB.prepare(
    'SELECT user_id FROM trip_members WHERE trip_id = ? AND user_id = ?'
  ).bind(tripId, user.id).first();

  if (!existing) {
    await c.env.DB.prepare(
      'INSERT INTO trip_members (trip_id, user_id, role) VALUES (?, ?, \'member\')'
    ).bind(tripId, user.id).run();
  }

  // Return updated member list
  const { results } = await c.env.DB.prepare(
    `SELECT u.id, u.name, u.email, u.picture_url, u.color, tm.role
     FROM trip_members tm
     JOIN users u ON u.id = tm.user_id
     WHERE tm.trip_id = ?
     ORDER BY tm.role DESC, tm.joined_at ASC`
  ).bind(tripId).all();

  return c.json(results);
});

// Remove a member from a trip
app.delete('/:tripId/members/:userId', async (c) => {
  const user = c.get('user');
  const tripId = c.req.param('tripId');
  const targetUserId = c.req.param('userId');

  // Only the owner can remove members
  const callerMembership = await c.env.DB.prepare(
    'SELECT role FROM trip_members WHERE trip_id = ? AND user_id = ?'
  ).bind(tripId, user.id).first();
  if (!callerMembership || callerMembership.role !== 'owner') {
    return c.json({ error: 'Only the trip owner can remove members' }, 403);
  }

  // Cannot remove yourself (the owner)
  if (targetUserId === user.id) {
    return c.json({ error: 'Cannot remove yourself as the owner' }, 400);
  }

  await c.env.DB.prepare(
    'DELETE FROM trip_members WHERE trip_id = ? AND user_id = ?'
  ).bind(tripId, targetUserId).run();

  // Also remove from segment_members for this trip
  await c.env.DB.prepare(
    `DELETE FROM segment_members WHERE user_id = ? AND segment_id IN
     (SELECT id FROM segments WHERE trip_id = ?)`
  ).bind(targetUserId, tripId).run();

  return c.json({ ok: true });
});

export { app as membersRoutes };
