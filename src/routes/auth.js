import { Hono } from 'hono';

const app = new Hono();

// --- HMAC helpers ---
async function signState(payload, secret) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(payload)
  );
  return btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function verifyState(payload, signature, secret) {
  const expected = await signState(payload, secret);
  return expected === signature;
}

function parseCookies(cookieHeader) {
  const cookies = {};
  if (!cookieHeader) return cookies;
  for (const pair of cookieHeader.split(';')) {
    const [name, ...rest] = pair.trim().split('=');
    if (name) cookies[name.trim()] = rest.join('=').trim();
  }
  return cookies;
}

// GET /api/auth/google — Start OAuth flow
app.get('/google', async (c) => {
  const clientId = c.env.GOOGLE_CLIENT_ID;
  const secret = c.env.GOOGLE_CLIENT_SECRET;

  if (!clientId || !secret) {
    return c.json({ error: 'Google OAuth not configured' }, 500);
  }

  const redirectUri = new URL('/api/auth/google/callback', c.req.url).toString();

  // Build state: timestamp.linkToken.returnTo.hmac
  const timestamp = Date.now().toString();

  // Check if there's an existing token to link (from query param or cookie)
  const urlParams = new URL(c.req.url).searchParams;
  const linkToken = urlParams.get('link_token') || '';
  const returnTo = urlParams.get('return_to') || '';
  const payload = `${timestamp}.${linkToken}.${returnTo}`;
  const hmac = await signState(payload, secret);
  const state = `${payload}.${hmac}`;

  // Set state cookie for CSRF protection
  const headers = new Headers();
  headers.append('Set-Cookie', `oauth_state=${encodeURIComponent(state)}; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=300`);

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    access_type: 'online',
    prompt: 'select_account'
  });

  headers.set('Location', `https://accounts.google.com/o/oauth2/v2/auth?${params}`);
  return new Response(null, { status: 302, headers });
});

// GET /api/auth/google/callback — Handle OAuth callback
app.get('/google/callback', async (c) => {
  const clientId = c.env.GOOGLE_CLIENT_ID;
  const secret = c.env.GOOGLE_CLIENT_SECRET;
  const url = new URL(c.req.url);
  const code = url.searchParams.get('code');
  const stateParam = url.searchParams.get('state');
  const error = url.searchParams.get('error');

  if (error) {
    return c.redirect('/login.html?error=access_denied');
  }

  if (!code || !stateParam) {
    return c.redirect('/login.html?error=missing_params');
  }

  // Verify state (CSRF protection)
  const cookies = parseCookies(c.req.header('Cookie'));
  const stateCookie = cookies.oauth_state ? decodeURIComponent(cookies.oauth_state) : null;
  if (!stateCookie || stateCookie !== stateParam) {
    return c.redirect('/login.html?error=state_mismatch');
  }

  // Parse state: timestamp.linkToken.returnTo.hmac
  const parts = stateParam.split('.');
  if (parts.length < 3) {
    return c.redirect('/login.html?error=invalid_state');
  }
  const hmac = parts.pop();
  const payload = parts.join('.');
  const valid = await verifyState(payload, hmac, secret);
  if (!valid) {
    return c.redirect('/login.html?error=state_tampered');
  }

  // Check timestamp (5 min window)
  const timestamp = parseInt(parts[0]);
  if (Date.now() - timestamp > 300000) {
    return c.redirect('/login.html?error=state_expired');
  }

  const linkToken = parts[1] || '';
  // returnTo may contain dots (e.g. /share.html?token=x), so rejoin remaining parts
  const returnTo = parts.slice(2).join('.') || '';

  // Exchange code for tokens
  const redirectUri = new URL('/api/auth/google/callback', c.req.url).toString();
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: secret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code'
    })
  });

  if (!tokenRes.ok) {
    return c.redirect('/login.html?error=token_exchange');
  }

  const tokens = await tokenRes.json();

  // Fetch user info
  const userInfoRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { Authorization: `Bearer ${tokens.access_token}` }
  });

  if (!userInfoRes.ok) {
    return c.redirect('/login.html?error=userinfo_failed');
  }

  const googleUser = await userInfoRes.json();
  const googleId = googleUser.id;
  const email = googleUser.email || null;
  const name = googleUser.name || googleUser.email || '';
  const pictureUrl = googleUser.picture || '';

  // Account resolution
  let user = null;
  let token = null;

  // 1. Check if user with this google_id already exists
  user = await c.env.DB.prepare(
    'SELECT id, token, name, email FROM users WHERE google_id = ?'
  ).bind(googleId).first();

  if (user) {
    // Update profile info
    await c.env.DB.prepare(
      'UPDATE users SET name = ?, email = ?, picture_url = ?, updated_at = datetime(\'now\') WHERE id = ?'
    ).bind(name, email, pictureUrl, user.id).run();
    token = user.token;
  }

  // 2. Try to link an existing anonymous account
  if (!user && linkToken) {
    const existingUser = await c.env.DB.prepare(
      'SELECT id, token FROM users WHERE token = ? AND google_id IS NULL'
    ).bind(linkToken).first();

    if (existingUser) {
      await c.env.DB.prepare(
        'UPDATE users SET google_id = ?, email = ?, name = ?, picture_url = ?, updated_at = datetime(\'now\') WHERE id = ?'
      ).bind(googleId, email, name, pictureUrl, existingUser.id).run();
      user = existingUser;
      token = existingUser.token;
    }
  }

  // 3. Create new user
  if (!user) {
    const id = crypto.randomUUID();
    token = crypto.randomUUID();
    const colors = ['#22C55E', '#3B82F6', '#EF4444', '#F59E0B', '#8B5CF6', '#0EA5E9', '#EA580C', '#6366F1'];
    const color = colors[Math.floor(Math.random() * colors.length)];

    await c.env.DB.prepare(
      'INSERT INTO users (id, email, name, token, google_id, picture_url, color) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).bind(id, email, name, token, googleId, pictureUrl, color).run();

    // Auto-create a primary traveler
    const travelerId = crypto.randomUUID();
    await c.env.DB.prepare(
      'INSERT INTO travelers (id, user_id, name, color, is_primary) VALUES (?, ?, ?, ?, 1)'
    ).bind(travelerId, id, name || 'Me', color).run();

    user = { id, token: token };
  }

  // Determine redirect destination — use return_to if safe, otherwise dashboard
  let redirectTo = '/';
  if (returnTo && returnTo.startsWith('/') && !returnTo.startsWith('//')) {
    redirectTo = returnTo;
  }

  // Set cookie and redirect
  const headers = new Headers();
  headers.append('Set-Cookie', `tiq_token=${token}; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=${30 * 24 * 60 * 60}`);
  // Clear the oauth_state cookie
  headers.append('Set-Cookie', 'oauth_state=; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=0');
  headers.set('Location', redirectTo);
  return new Response(null, { status: 302, headers });
});

// POST /api/auth/logout
app.post('/logout', async (c) => {
  const headers = new Headers();
  headers.append('Set-Cookie', 'tiq_token=; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=0');
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { ...Object.fromEntries(headers), 'Content-Type': 'application/json' }
  });
});

export { app as authRoutes };
