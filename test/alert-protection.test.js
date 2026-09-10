const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const TEST_DB_DIR = path.join(__dirname, '..', 'data', 'alert-protection-test');
process.env.VYNTRIX_DATA_DIR = TEST_DB_DIR;
process.env.VYNTRIX_MAX_ALERTS_PER_USER = '2';
process.env.VYNTRIX_ALERT_UPLOAD_LIMIT = '3';
process.env.VYNTRIX_ALERT_UPLOAD_WINDOW_MS = '60000';

const { server } = require('../backend/server');
const db = require('../backend/db');
let baseUrl;

const VALID_JPEG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMCwsKCwsMDQ4SEA0OEQ4LCxAWEBETFBUVFQ4PFx8WFBgSFBUU/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBL/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAb/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AKwA//9k=';

function request(method, reqPath, body, cookie) {
  return new Promise((resolve, reject) => {
    const url = new URL(reqPath, baseUrl);
    const req = http.request(url, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(cookie ? { Cookie: cookie } : {})
      }
    }, (res) => {
      let responseBody = '';
      res.on('data', (chunk) => { responseBody += chunk; });
      res.on('end', () => {
        let parsedBody;
        try { parsedBody = JSON.parse(responseBody); } catch (_) { parsedBody = responseBody; }
        resolve({ status: res.statusCode, body: parsedBody, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function extractCookie(headers) {
  return headers['set-cookie'][0].split(';')[0];
}

async function register(username) {
  const response = await request('POST', '/api/auth/register', {
    username,
    password: 'testpass123'
  });
  assert.strictEqual(response.status, 200);
  return extractCookie(response.headers);
}

async function upload(cookie, image = VALID_JPEG) {
  return request('POST', '/api/alerts/upload', {
    cameraName: 'Protection Test Camera',
    image
  }, cookie);
}

before(async () => {
  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      baseUrl = `http://127.0.0.1:${address.port}`;
      resolve();
    });
  });
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
});

describe('Alert upload protection', () => {
  it('enforces the per-user upload rate limit', async () => {
    const cookie = await register(`ratelimit_${Date.now()}`);

    assert.strictEqual((await upload(cookie)).status, 200);
    assert.strictEqual((await upload(cookie)).status, 200);
    assert.strictEqual((await upload(cookie)).status, 200);

    const limited = await upload(cookie);
    assert.strictEqual(limited.status, 429);
    assert.match(limited.body.error, /Too many alert uploads/);
  });

  it('rejects an image larger than the configured maximum with 413', async () => {
    const cookie = await register(`oversized_${Date.now()}`);
    const oversizedImage = `data:image/jpeg;base64,${Buffer.alloc(2 * 1024 * 1024 + 1).toString('base64')}`;

    const response = await upload(cookie, oversizedImage);
    assert.strictEqual(response.status, 413);
    assert.match(response.body.error, /no larger than|between 1 byte and/i);
  });

  it('retains the maximum number of alerts independently per user', async () => {
    const firstCookie = await register(`retention_a_${Date.now()}`);
    const secondCookie = await register(`retention_b_${Date.now()}`);

    const first = await upload(firstCookie);
    const second = await upload(firstCookie);
    const third = await upload(firstCookie);
    assert.strictEqual(first.status, 200);
    assert.strictEqual(second.status, 200);
    assert.strictEqual(third.status, 200);

    const retained = await request('GET', '/api/alerts', null, firstCookie);
    assert.strictEqual(retained.status, 200);
    assert.strictEqual(retained.body.alerts.length, 2);
    assert.ok(!retained.body.alerts.some(alert => alert.id === first.body.alert.id));

    const otherUserAlert = await upload(secondCookie);
    assert.strictEqual(otherUserAlert.status, 200);
    const otherUserAlerts = await request('GET', '/api/alerts', null, secondCookie);
    assert.strictEqual(otherUserAlerts.body.alerts.length, 1);
  });

  it('returns 500 when alert persistence fails instead of reporting success', async () => {
    const cookie = await register(`storage_${Date.now()}`);
    const originalAddAlert = db.addAlert;
    db.addAlert = () => {
      const error = new Error('simulated storage failure');
      error.code = 'STORAGE_WRITE_FAILED';
      throw error;
    };

    try {
      const response = await upload(cookie);
      assert.strictEqual(response.status, 500);
      assert.deepStrictEqual(response.body, { error: 'Alert could not be saved. Please try again.' });
    } finally {
      db.addAlert = originalAddAlert;
    }
  });
});
