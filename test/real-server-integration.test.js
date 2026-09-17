const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { io } = require('socket.io-client');

const TEST_DB_DIR = path.join(__dirname, '..', 'data', 'real-server-test');
process.env.VYNTRIX_DATA_DIR = TEST_DB_DIR;
process.env.VYNTRIX_DATABASE_MODE = 'json';
process.env.VYNTRIX_ALERT_UPLOAD_LIMIT = '100';
process.env.VYNTRIX_MAX_ALERTS_PER_USER = '100';

const { server } = require('../backend/server');
let baseUrl;
const sockets = new Set();

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
  const setCookie = headers['set-cookie'];
  assert.ok(setCookie && setCookie.length, 'Expected the server to set a session cookie');
  return setCookie[0].split(';')[0];
}

async function register(username) {
  const response = await request('POST', '/api/auth/register', {
    username,
    password: 'testpass123'
  });
  assert.strictEqual(response.status, 200);
  return { cookie: extractCookie(response.headers), user: response.body.user };
}

function waitForEvent(socket, eventName, timeoutMs = 1000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(eventName, onEvent);
      reject(new Error(`Timed out waiting for Socket.IO event: ${eventName}`));
    }, timeoutMs);

    function onEvent(...args) {
      clearTimeout(timer);
      socket.off(eventName, onEvent);
      resolve(args.length === 1 ? args[0] : args);
    }

    socket.once(eventName, onEvent);
  });
}

function emitWithAck(socket, eventName, payload, timeoutMs = 1000) {
  return new Promise((resolve, reject) => {
    socket.timeout(timeoutMs).emit(eventName, payload, (error, response) => {
      if (error) reject(error);
      else resolve(response);
    });
  });
}

function connectSocket(cookie, { reconnection = false } = {}) {
  const socket = io(baseUrl, {
    transports: ['websocket'],
    reconnection,
    reconnectionAttempts: 5,
    reconnectionDelay: 50,
    ...(cookie ? { extraHeaders: { Cookie: cookie } } : {})
  });
  sockets.add(socket);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out connecting to Socket.IO')), 1000);
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once('connect_error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function waitForCameraList(socket, predicate, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('camera-list-update', onUpdate);
      reject(new Error('Timed out waiting for the expected camera list'));
    }, timeoutMs);

    function onUpdate(cameras) {
      if (!predicate(cameras)) return;
      clearTimeout(timer);
      socket.off('camera-list-update', onUpdate);
      resolve(cameras);
    }

    socket.on('camera-list-update', onUpdate);
  });
}

async function registerDevice(socket, type, cameraName) {
  const listPromise = waitForEvent(socket, 'camera-list-update');
  socket.emit('register-device', { type, cameraName });
  return listPromise;
}

function closeSocket(socket) {
  return new Promise((resolve) => {
    if (!socket.connected) {
      sockets.delete(socket);
      resolve();
      return;
    }
    socket.once('disconnect', () => {
      sockets.delete(socket);
      resolve();
    });
    socket.close();
  });
}

async function closeAllSockets() {
  await Promise.all([...sockets].map(closeSocket));
}

function listen() {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      baseUrl = `http://127.0.0.1:${address.port}`;
      resolve();
    });
  });
}

function stopServer() {
  return new Promise((resolve) => server.close(resolve));
}

before(listen);

after(async () => {
  await Promise.all([...sockets].map(closeSocket));
  if (server.listening) await stopServer();
  fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
});

describe('Actual Vyntrix server HTTP integration', () => {
  it('registers and logs in through the real server with persistent sessions', async () => {
    const username = `serverauth_${Date.now()}`;
    const registration = await register(username);

    const session = await request('GET', '/api/auth/session', null, registration.cookie);
    assert.strictEqual(session.status, 200);
    assert.strictEqual(session.body.loggedIn, true);
    assert.strictEqual(session.body.user.username, username);

    const logout = await request('POST', '/api/auth/logout', null, registration.cookie);
    assert.strictEqual(logout.status, 200);

    const loggedOut = await request('GET', '/api/devices/active-cameras', null, registration.cookie);
    assert.strictEqual(loggedOut.status, 401);

    const login = await request('POST', '/api/auth/login', {
      username,
      password: 'testpass123'
    });
    assert.strictEqual(login.status, 200);
    const loginCookie = extractCookie(login.headers);
    const protectedRoute = await request('GET', '/api/devices/active-cameras', null, loginCookie);
    assert.strictEqual(protectedRoute.status, 200);
  });

  it('rejects unauthenticated access to protected routes', async () => {
    const response = await request('GET', '/api/alerts');
    assert.strictEqual(response.status, 401);
    assert.deepStrictEqual(response.body, { error: 'Unauthorized' });
  });

  it('serves only the normalized ICE configuration to authenticated clients', async () => {
    const user = await register(`ice_${Date.now()}`);
    const response = await request('GET', '/api/webrtc/ice-servers', null, user.cookie);
    assert.strictEqual(response.status, 200);
    assert.ok(Array.isArray(response.body.iceServers));
    assert.ok(response.body.iceServers.length >= 1);
    assert.ok(!JSON.stringify(response.body).includes('SESSION_SECRET'));
    assert.deepStrictEqual(Object.keys(response.body), ['iceServers']);
  });

  it('protects the ICE configuration endpoint', async () => {
    const response = await request('GET', '/api/webrtc/ice-servers');
    assert.strictEqual(response.status, 401);
  });
});

describe('Actual Vyntrix server Socket.IO integration', () => {
  it('rejects a Socket.IO client without an authenticated session', async () => {
    const socket = io(baseUrl, { transports: ['websocket'], reconnection: false });
    sockets.add(socket);

    const outcome = await Promise.race([
      waitForEvent(socket, 'disconnect').then(() => 'disconnected'),
      waitForEvent(socket, 'connect_error').then(() => 'connect_error')
    ]);
    assert.ok(['disconnected', 'connect_error'].includes(outcome));
    await closeSocket(socket);
  });

  it('authenticates device registration and isolates camera lists by user', async () => {
    const userA = await register(`socket_a_${Date.now()}`);
    const userB = await register(`socket_b_${Date.now()}`);
    const cameraA = await connectSocket(userA.cookie);
    const cameraB = await connectSocket(userB.cookie);

    await registerDevice(cameraA, 'camera', 'User A Camera');
    await registerDevice(cameraB, 'camera', 'User B Camera');

    const monitorA = await connectSocket(userA.cookie);
    const monitorB = await connectSocket(userB.cookie);
    const camerasForA = await registerDevice(monitorA, 'monitor');
    const camerasForB = await registerDevice(monitorB, 'monitor');

    assert.deepStrictEqual(camerasForA.map(camera => camera.cameraName), ['User A Camera']);
    assert.deepStrictEqual(camerasForB.map(camera => camera.cameraName), ['User B Camera']);
  });

  it('blocks cross-user signaling, siren, and camera-switch commands', async () => {
    const userA = await register(`socket_command_a_${Date.now()}`);
    const userB = await register(`socket_command_b_${Date.now()}`);
    const monitorA = await connectSocket(userA.cookie);
    const cameraB = await connectSocket(userB.cookie);
    await registerDevice(monitorA, 'monitor');
    await registerDevice(cameraB, 'camera', 'Protected Camera');

    let receivedSignal = false;
    let receivedSiren = false;
    let receivedCameraSwitch = false;
    cameraB.on('webrtc-signal', () => { receivedSignal = true; });
    cameraB.on('trigger-siren', () => { receivedSiren = true; });
    cameraB.on('camera:switch', () => { receivedCameraSwitch = true; });

    monitorA.emit('webrtc-signal', {
      targetSocketId: cameraB.id,
      signalData: { offer: { type: 'offer', sdp: 'cross-user-test' } }
    });
    monitorA.emit('trigger-siren', {
      targetSocketId: cameraB.id,
      action: 'start'
    });
    const switchResult = await emitWithAck(monitorA, 'camera:switch', {
      targetSocketId: cameraB.id,
      facingMode: 'user'
    });

    await new Promise(resolve => setTimeout(resolve, 150));
    assert.strictEqual(receivedSignal, false);
    assert.strictEqual(receivedSiren, false);
    assert.strictEqual(receivedCameraSwitch, false);
    assert.strictEqual(switchResult.success, false);
  });

  it('forwards camera-switch commands only to a same-user registered camera', async () => {
    const user = await register(`socket_switch_${Date.now()}`);
    const monitor = await connectSocket(user.cookie);
    const camera = await connectSocket(user.cookie);
    await registerDevice(monitor, 'monitor');
    await registerDevice(camera, 'camera', 'Switchable Camera');

    camera.on('camera:switch', ({ facingMode }, acknowledge) => {
      acknowledge({ success: true, facingMode, message: 'Camera switched.' });
    });

    const result = await emitWithAck(monitor, 'camera:switch', {
      targetSocketId: camera.id,
      facingMode: 'environment'
    });

    assert.deepStrictEqual(result, {
      success: true,
      facingMode: 'environment',
      message: 'Camera switched.'
    });
  });

  it('removes stale camera registrations and supports authenticated reconnect registration', async () => {
    const user = await register(`socket_reconnect_${Date.now()}`);
    const camera = await connectSocket(user.cookie, { reconnection: true });
    const monitor = await connectSocket(user.cookie);
    const cameraName = 'Reconnect Camera';

    await registerDevice(camera, 'camera', cameraName);
    await registerDevice(monitor, 'monitor');
    const oldSocketId = camera.id;

    camera.on('connect', () => {
      if (camera.id !== oldSocketId) {
        camera.emit('register-device', { type: 'camera', cameraName });
      }
    });

    const refreshedList = waitForCameraList(monitor, (cameras) => (
      cameras.length === 1 && cameras[0].cameraName === cameraName && cameras[0].socketId !== oldSocketId
    ));
    camera.io.engine.close();
    const cameras = await refreshedList;

    assert.strictEqual(cameras.length, 1);
    assert.notStrictEqual(cameras[0].socketId, oldSocketId);
  });
});

describe('Actual Vyntrix server alert ownership integration', () => {
  it('creates, retrieves, and deletes a metadata-only alert', async () => {
    const user = await register(`metadata_alert_${Date.now()}`);
    const created = await request('POST', '/api/alerts/upload', {
      cameraName: 'Metadata Camera'
    }, user.cookie);
    assert.strictEqual(created.status, 200);
    assert.strictEqual(created.body.alert.cameraName, 'Metadata Camera');
    assert.strictEqual(created.body.alert.imagePath, undefined);

    const alerts = await request('GET', '/api/alerts', null, user.cookie);
    assert.strictEqual(alerts.status, 200);
    assert.ok(alerts.body.alerts.some(alert => alert.id === created.body.alert.id));

    const image = await request('GET', `/api/alerts/${created.body.alert.id}/image`, null, user.cookie);
    assert.strictEqual(image.status, 404);

    const deletion = await request('DELETE', `/api/alerts/${created.body.alert.id}`, null, user.cookie);
    assert.strictEqual(deletion.status, 200);
  });

  it('prevents one user from reading or deleting another user\'s alerts', async () => {
    const userA = await register(`alerts_a_${Date.now()}`);
    const userB = await register(`alerts_b_${Date.now()}`);
    const created = await request('POST', '/api/alerts/upload', {
      cameraName: 'User B Camera',
      image: VALID_JPEG
    }, userB.cookie);
    assert.strictEqual(created.status, 200);

    const alertId = created.body.alert.id;
    const userAAlerts = await request('GET', '/api/alerts', null, userA.cookie);
    assert.strictEqual(userAAlerts.status, 200);
    assert.deepStrictEqual(userAAlerts.body.alerts, []);

    const image = await request('GET', `/api/alerts/${alertId}/image`, null, userA.cookie);
    assert.strictEqual(image.status, 404);

    const deletion = await request('DELETE', `/api/alerts/${alertId}`, null, userA.cookie);
    assert.strictEqual(deletion.status, 404);

    const ownerAlerts = await request('GET', '/api/alerts', null, userB.cookie);
    assert.strictEqual(ownerAlerts.status, 200);
    assert.strictEqual(ownerAlerts.body.alerts.length, 1);
  });
});

describe('Actual Vyntrix server restart integration', () => {
  it('preserves a valid session across a server restart', async () => {
    const user = await register(`restart_${Date.now()}`);
    await closeAllSockets();
    await stopServer();
    await listen();

    const session = await request('GET', '/api/auth/session', null, user.cookie);
    assert.strictEqual(session.status, 200);
    assert.strictEqual(session.body.loggedIn, true);
  });
});
