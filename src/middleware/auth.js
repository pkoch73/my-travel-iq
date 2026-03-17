function parseCookies(cookieHeader) {
  const cookies = {};
  if (!cookieHeader) return cookies;
  for (const pair of cookieHeader.split(';')) {
    const [name, ...rest] = pair.trim().split('=');
    if (name) cookies[name.trim()] = rest.join('=').trim();
  }
  return cookies;
}

export async function authMiddleware(c, next) {
  let token = null;

  // 1. Check Authorization header first
  const authHeader = c.req.header('Authorization');
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.slice(7);
  }

  // 2. Fall back to cookie
  if (!token) {
    const cookies = parseCookies(c.req.header('Cookie'));
    token = cookies.tiq_token || null;
  }

  if (!token) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const user = await c.env.DB.prepare(
    'SELECT id, email, name, picture_url, color FROM users WHERE token = ?'
  ).bind(token).first();
  if (!user) {
    return c.json({ error: 'Invalid token' }, 401);
  }
  c.set('user', user);
  await next();
}
