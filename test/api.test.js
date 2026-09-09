const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const express = require('express');
const session = require('express-session');
const fs = require('fs');
const path = require('path');

// We'll build a lightweight test server using the same route logic
const TEST_DB_DIR = path.join(__dirname, '..', 'data', 'api-test');
process.env.VYNTRIX_DATA_DIR = TEST_DB_DIR;
const db = require('../backend/db');

const app = express();
const server = http.createServer(app);
let baseUrl;

const sessionMiddleware = session({
  secret: 'test-secret-for-testing-only-32chars!!',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 60000, httpOnly: true, sameSite: 'lax', secure: false }
});

app.use(sessionMiddleware);
app.use(express.json({ limit: '3mb' }));

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});

// Auth routes (copied from server.js for testing)
app.post('/api/auth/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }
  if (username.length < 3 || password.length < 6) {
    return res.status(400).json({ error: 'Username must be at least 3 characters and password at least 6 characters' });
  }
  try {
    const user = await db.createUser(username, password);
    req.session.user = user;
    return res.json({ success: true, user });
  } catch (err) {
    console.error('Registration error:', err.message);
    return res.status(400).json({ error: err.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }
  try {
    const user = await db.verifyUser(username, password);
    if (!user) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }
    req.session.user = user;
    return res.json({ success: true, user });
  } catch (err) {
    console.error('Login error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) return res.status(500).json({ error: 'Could not log out' });
    res.clearCookie('connect.sid');
    return res.json({ success: true });
  });
});

app.get('/api/auth/session', (req, res) => {
  if (req.session.user) {
    return res.json({ loggedIn: true, user: req.session.user });
  }
  return res.json({ loggedIn: false });
});

const requireAuth = (req, res, next) => {
  if (!req.session.user) return res.status(401).json({ error: 'Unauthorized' });
  next();
};

app.get('/api/devices/active-cameras', requireAuth, (req, res) => {
  res.json({ count: 0, cameras: [] });
});

const toAlertResponse = (alert) => ({
  id: alert.id,
  cameraName: alert.cameraName,
  timestamp: alert.timestamp,
  imagePath: `/api/alerts/${encodeURIComponent(alert.id)}/image`
});

app.get('/api/alerts', requireAuth, (req, res) => {
  const alerts = db.getAlertsForUser(req.session.user.id).map(toAlertResponse);
  res.json({ alerts });
});

app.get('/api/alerts/:id/image', requireAuth, (req, res) => {
  const filePath = db.getAlertFilePath(req.session.user.id, req.params.id);
  if (!filePath) return res.status(404).json({ error: 'Alert image not found' });
  return res.sendFile(filePath);
});

app.post('/api/alerts/upload', requireAuth, (req, res) => {
  const { cameraName, image } = req.body;
  if (!image) return res.status(400).json({ error: 'Image content is required' });
  try {
    const alert = db.addAlert(req.session.user.id, cameraName, image);
    return res.json({ success: true, alert: toAlertResponse(alert) });
  } catch (err) {
    console.error('Failed to upload alert:', err.message);
    return res.status(400).json({ error: err.message || 'Failed to upload alert' });
  }
});

app.delete('/api/alerts/:id', requireAuth, (req, res) => {
  const success = db.deleteAlert(req.session.user.id, req.params.id);
  if (success) return res.json({ success: true });
  return res.status(404).json({ error: 'Alert not found or unauthorized' });
});

// Helper to make HTTP requests
function request(method, reqPath, body, cookies) {
  return new Promise((resolve, reject) => {
    const url = new URL(reqPath, baseUrl);
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method,
      headers: { 'Content-Type': 'application/json' },
    };
    if (cookies) options.headers['Cookie'] = cookies;

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(data); } catch (_) { parsed = data; }
        resolve({ status: res.statusCode, body: parsed, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function extractCookies(headers) {
  const setCookie = headers['set-cookie'];
  if (!setCookie) return '';
  return Array.isArray(setCookie)
    ? setCookie.map((c) => c.split(';')[0]).join('; ')
    : setCookie.split(';')[0];
}

// Use unique usernames per test run to avoid collisions with persisted data
const ts = Date.now();
const TEST_USER = `apitest_${ts}`;
const ALERT_USER = `alertuser_${ts}`;

const VALID_JPEG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMCwsKCwsMDQ4SEA0OEQ4LCxAWEBETFBUVFQ4PFx8WFBgSFBUU/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBL/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAb/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AKwA//9k=';

before(async () => {
  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
});

after(() => {
  return new Promise((resolve) => server.close(() => {
    fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
    resolve();
  }));
});

describe('Auth API Routes', () => {
  let sessionCookie = '';

  describe('POST /api/auth/register', () => {
    it('should register a new user', async () => {
      const res = await request('POST', '/api/auth/register', {
        username: TEST_USER,
        password: 'testpass123',
      });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.success, true);
      assert.ok(res.body.user.id);
      assert.strictEqual(res.body.user.username, TEST_USER);
      sessionCookie = extractCookies(res.headers);
      assert.ok(sessionCookie, 'Should set a session cookie');
    });

    it('should reject duplicate username', async () => {
      const res = await request('POST', '/api/auth/register', {
        username: TEST_USER,
        password: 'testpass123',
      });
      assert.strictEqual(res.status, 400);
      assert.ok(res.body.error.includes('already exists'));
    });

    it('should reject short username', async () => {
      const res = await request('POST', '/api/auth/register', {
        username: 'ab',
        password: 'testpass123',
      });
      assert.strictEqual(res.status, 400);
    });

    it('should reject short password', async () => {
      const res = await request('POST', '/api/auth/register', {
        username: 'newuser',
        password: '12345',
      });
      assert.strictEqual(res.status, 400);
    });

    it('should reject missing fields', async () => {
      const res = await request('POST', '/api/auth/register', {});
      assert.strictEqual(res.status, 400);
    });
  });

  describe('POST /api/auth/login', () => {
    it('should login with valid credentials', async () => {
      const res = await request('POST', '/api/auth/login', {
        username: TEST_USER,
        password: 'testpass123',
      });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.success, true);
      sessionCookie = extractCookies(res.headers);
    });

    it('should reject wrong password', async () => {
      const res = await request('POST', '/api/auth/login', {
        username: TEST_USER,
        password: 'wrongpassword',
      });
      assert.strictEqual(res.status, 401);
    });

    it('should reject non-existent user', async () => {
      const res = await request('POST', '/api/auth/login', {
        username: 'nonexistent_user_xyz',
        password: 'testpass123',
      });
      assert.strictEqual(res.status, 401);
    });

    it('should reject missing fields', async () => {
      const res = await request('POST', '/api/auth/login', {});
      assert.strictEqual(res.status, 400);
    });
  });

  describe('GET /api/auth/session', () => {
    it('should return logged-in user when session exists', async () => {
      const res = await request('GET', '/api/auth/session', null, sessionCookie);
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.loggedIn, true);
      assert.ok(res.body.user.id);
    });

    it('should return logged-out when no session', async () => {
      const res = await request('GET', '/api/auth/session');
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.loggedIn, false);
    });
  });

  describe('POST /api/auth/logout', () => {
    it('should logout successfully', async () => {
      const res = await request('POST', '/api/auth/logout', null, sessionCookie);
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.success, true);
    });

    it('should show logged-out after logout', async () => {
      const res = await request('GET', '/api/auth/session', null, sessionCookie);
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.loggedIn, false);
    });
  });
});

describe('Protected API Routes (unauthenticated)', () => {
  it('GET /api/alerts should return 401', async () => {
    const res = await request('GET', '/api/alerts');
    assert.strictEqual(res.status, 401);
  });

  it('GET /api/devices/active-cameras should return 401', async () => {
    const res = await request('GET', '/api/devices/active-cameras');
    assert.strictEqual(res.status, 401);
  });

  it('POST /api/alerts/upload should return 401', async () => {
    const res = await request('POST', '/api/alerts/upload', {
      cameraName: 'test',
      image: 'data:image/jpeg;base64,/9j/4AAQ',
    });
    assert.strictEqual(res.status, 401);
  });

  it('DELETE /api/alerts/:id should return 401', async () => {
    const res = await request('DELETE', '/api/alerts/someid');
    assert.strictEqual(res.status, 401);
  });
});

describe('Alert API Routes (authenticated)', () => {
  let authCookie = '';

  before(async () => {
    const regRes = await request('POST', '/api/auth/register', {
      username: ALERT_USER,
      password: 'testpass123',
    });
    authCookie = extractCookies(regRes.headers);
  });

  describe('POST /api/alerts/upload', () => {
    it('should upload a valid JPEG alert', async () => {
      const res = await request('POST', '/api/alerts/upload', {
        cameraName: 'Test Camera',
        image: VALID_JPEG,
      }, authCookie);
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.success, true);
      assert.ok(res.body.alert.id);
      assert.strictEqual(res.body.alert.cameraName, 'Test Camera');
      assert.ok(res.body.alert.imagePath);
    });

    it('should reject invalid image format', async () => {
      const res = await request('POST', '/api/alerts/upload', {
        cameraName: 'Test',
        image: 'not-a-data-url',
      }, authCookie);
      assert.strictEqual(res.status, 400);
    });

    it('should reject missing image', async () => {
      const res = await request('POST', '/api/alerts/upload', {
        cameraName: 'Test',
      }, authCookie);
      assert.strictEqual(res.status, 400);
    });
  });

  describe('GET /api/alerts', () => {
    it('should return list of alerts', async () => {
      const res = await request('GET', '/api/alerts', null, authCookie);
      assert.strictEqual(res.status, 200);
      assert.ok(Array.isArray(res.body.alerts));
      assert.ok(res.body.alerts.length > 0);
      assert.ok(res.body.alerts[0].imagePath);
    });
  });

  describe('GET /api/alerts/:id/image', () => {
    it('should return 404 for non-existent alert', async () => {
      const res = await request('GET', '/api/alerts/nonexistent/image', null, authCookie);
      assert.strictEqual(res.status, 404);
    });
  });

  describe('DELETE /api/alerts/:id', () => {
    it('should return 404 for non-existent alert', async () => {
      const res = await request('DELETE', '/api/alerts/nonexistent', null, authCookie);
      assert.strictEqual(res.status, 404);
    });
  });
});

describe('Security Headers', () => {
  it('should include X-Content-Type-Options: nosniff', async () => {
    const res = await request('GET', '/api/auth/session');
    assert.strictEqual(res.headers['x-content-type-options'], 'nosniff');
  });

  it('should include X-Frame-Options: SAMEORIGIN', async () => {
    const res = await request('GET', '/api/auth/session');
    assert.strictEqual(res.headers['x-frame-options'], 'SAMEORIGIN');
  });

  it('should include Referrer-Policy: same-origin', async () => {
    const res = await request('GET', '/api/auth/session');
    assert.strictEqual(res.headers['referrer-policy'], 'same-origin');
  });
});
