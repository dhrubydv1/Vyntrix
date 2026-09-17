const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const session = require('express-session');
const rateLimit = require('express-rate-limit');
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env.local') });

const db = require('./db');
const {
  DATA_DIR,
  ALERT_UPLOAD_LIMIT,
  ALERT_UPLOAD_WINDOW_MS,
  ICE_SERVERS,
  FRONTEND_ORIGIN
} = require('./config');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 2 * 1024 * 1024,
  cors: FRONTEND_ORIGIN ? { origin: FRONTEND_ORIGIN, credentials: true } : undefined
});

const PORT = process.env.PORT || 3050;
const isProduction = process.env.NODE_ENV === 'production';

if (isProduction && !process.env.SESSION_SECRET) {
  throw new Error('SESSION_SECRET must be set when NODE_ENV=production');
}

if (isProduction) app.set('trust proxy', 1);

// Session Configuration
const useFileSessionStore = !isProduction && process.env.VYNTRIX_DATABASE_MODE === 'json';
const sessionStore = useFileSessionStore
  ? new (require('session-file-store')(session))({
      path: path.join(DATA_DIR, 'sessions'),
      logFn: () => {}
    })
  : new (require('connect-pg-simple')(session))({
      pool: require('./postgres').pool,
      schemaName: 'public',
      tableName: 'user_sessions',
      createTableIfMissing: false,
      pruneSessionInterval: 15 * 60,
      errorLog: (message, error) => {
        console.error(message, error instanceof Error ? error.message : error);
      }
    });

const sessionMiddleware = session({
  secret: process.env.SESSION_SECRET || 'development-only-change-this-secret',
  name: 'sasta_cctv_session',
  store: sessionStore,
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 24 * 60 * 60 * 1000, // 1 day
    httpOnly: true,
    sameSite: FRONTEND_ORIGIN ? 'none' : 'lax',
    secure: isProduction || Boolean(FRONTEND_ORIGIN)
  }
});

app.use(sessionMiddleware);
app.use(express.json({ limit: '3mb' }));
app.use(express.urlencoded({ extended: true, limit: '3mb' }));

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'same-origin');
  if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
  next();
});

// Permit only the configured frontend to call the backend cross-origin. When
// unset, local same-origin development continues without CORS headers.
app.use((req, res, next) => {
  const origin = req.get('origin');
  if (origin && FRONTEND_ORIGIN && origin !== FRONTEND_ORIGIN) {
    return res.status(403).json({ error: 'Origin is not allowed' });
  }
  if (origin && FRONTEND_ORIGIN) {
    res.setHeader('Access-Control-Allow-Origin', FRONTEND_ORIGIN);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Vary', 'Origin');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Browsers send an Origin header for cross-site form/fetch requests. Reject a
// mismatched value before any state-changing API route to provide CSRF defence
// in addition to the SameSite session cookie.
app.use('/api', (req, res, next) => {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
  const origin = req.get('origin');
  if (!origin || origin === `${req.protocol}://${req.get('host')}` || origin === FRONTEND_ORIGIN) return next();
  return res.status(403).json({ error: 'Cross-origin requests are not allowed' });
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  skip: (req) => req.method !== 'POST',
  message: { error: 'Too many authentication attempts. Please try again later.' }
});
app.use('/api/auth', authLimiter);

const alertUploadLimiter = rateLimit({
  windowMs: ALERT_UPLOAD_WINDOW_MS,
  limit: ALERT_UPLOAD_LIMIT,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: (req) => `user:${req.session.user.id}`,
  message: { error: 'Too many alert uploads. Please wait before trying again.' }
});

// Serve Static Files
app.use(express.static(path.join(__dirname, '..', 'public')));

// Share session with Socket.io
io.use((socket, next) => {
  sessionMiddleware(socket.request, socket.request.res || {}, next);
});

// Authentication APIs
app.post('/api/auth/register', async (req, res) => {
  const { username, password } = req.body;
  if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }
  if (!/^[a-z0-9._-]{3,32}$/i.test(username.trim())) {
    return res.status(400).json({ error: 'Username must be 3–32 characters and use only letters, numbers, dots, hyphens, or underscores' });
  }
  if (password.length < 6 || password.length > 128) {
    return res.status(400).json({ error: 'Password must be between 6 and 128 characters' });
  }

  try {
    const user = await db.createUser(username, password);
    req.session.user = user;
    return res.json({ success: true, user });
  } catch (err) {
    console.error('Registration error:', err);
    return res.status(400).json({ error: err.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;
  if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) {
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
    if (err) {
      return res.status(500).json({ error: 'Could not log out' });
    }
    res.clearCookie('sasta_cctv_session', {
      sameSite: FRONTEND_ORIGIN ? 'none' : 'lax',
      secure: isProduction || Boolean(FRONTEND_ORIGIN)
    });
    return res.json({ success: true });
  });
});

app.get('/api/auth/session', (req, res) => {
  if (req.session.user) {
    return res.json({ loggedIn: true, user: req.session.user });
  }
  return res.json({ loggedIn: false });
});

// Middleware to protect API routes
const requireAuth = (req, res, next) => {
  if (!req.session.user) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
};

// ICE credentials are returned only to an authenticated browser that needs to
// establish a peer connection. Do not log this response; future deployments
// should replace the static credential with a short-lived TURN credential.
app.get('/api/webrtc/ice-servers', requireAuth, (req, res) => {
  res.json({ iceServers: ICE_SERVERS });
});

// Device APIs
app.get('/api/devices/active-cameras', requireAuth, (req, res) => {
  const cameras = getCamerasForUser(req.session.user.id);
  res.json({ count: cameras.length, cameras });
});

// Alert APIs
app.get('/api/alerts', requireAuth, async (req, res) => {
  const alerts = (await db.getAlertsForUser(req.session.user.id)).map(toAlertResponse);
  res.json({ alerts });
});

app.get('/api/alerts/:id/image', requireAuth, async (req, res) => {
  const filePath = await db.getAlertFilePath(req.session.user.id, req.params.id);
  if (!filePath) return res.status(404).json({ error: 'Alert image not found' });
  return res.sendFile(filePath);
});

app.post('/api/alerts/upload', requireAuth, alertUploadLimiter, async (req, res) => {
  const { cameraName, image } = req.body || {};

  try {
    const alert = await db.addAlert(req.session.user.id, cameraName, image);
    const responseAlert = toAlertResponse(alert);
    
    // Broadcast motion alert to monitors in real-time
    const userRoom = `user_${req.session.user.id}`;
    io.to(userRoom).emit('motion-alert', responseAlert);

    return res.json({ success: true, alert: responseAlert });
  } catch (err) {
    console.error('Failed to create alert:', err);
    if (err.code === 'ALERT_IMAGE_TOO_LARGE') {
      return res.status(413).json({ error: err.message });
    }
    if (err.code === 'STORAGE_WRITE_FAILED') {
      return res.status(500).json({ error: 'Alert could not be saved. Please try again.' });
    }
    return res.status(400).json({ error: err.message || 'Failed to upload alert' });
  }
});

// Return a clear JSON response when express.json rejects an oversized body.
app.use((err, req, res, next) => {
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Request body is too large.' });
  }
  return next(err);
});

app.delete('/api/alerts/:id', requireAuth, async (req, res) => {
  const success = await db.deleteAlert(req.session.user.id, req.params.id);
  if (success) {
    return res.json({ success: true });
  }
  return res.status(404).json({ error: 'Alert not found or unauthorized' });
});

// Real-time Socket.io Communications
const activeCameras = {}; // socket.id -> { userId, cameraName, socketId }

const toAlertResponse = (alert) => ({
  id: alert.id,
  cameraName: alert.cameraName,
  timestamp: alert.timestamp,
  ...((alert.imageFile || alert.imagePath) && {
    imagePath: `/api/alerts/${encodeURIComponent(alert.id)}/image`
  })
});

const getCamerasForUser = (userId) => {
  return Object.values(activeCameras)
    .filter(cam => cam.userId === userId)
    .map(cam => ({ socketId: cam.socketId, cameraName: cam.cameraName }));
};

io.on('connection', (socket) => {
  const sessionUser = socket.request.session ? socket.request.session.user : null;
  if (!sessionUser) {
    socket.disconnect(true);
    return;
  }

  socket.on('register-device', ({ type, cameraName } = {}) => {
    if (type !== 'camera' && type !== 'monitor') {
      socket.emit('app-error', 'Invalid device type');
      return;
    }

    const finalUserId = sessionUser.id;
    socket.userId = finalUserId;
    socket.deviceType = type;
    const userRoom = `user_${finalUserId}`;
    socket.join(userRoom);

    if (type === 'camera') {
      socket.cameraName = typeof cameraName === 'string' && cameraName.trim()
        ? cameraName.trim().slice(0, 64)
        : 'Unknown Camera';
      activeCameras[socket.id] = {
        userId: finalUserId,
        cameraName: socket.cameraName,
        socketId: socket.id
      };
      console.log(`Camera registered: "${socket.cameraName}" (User ID: ${finalUserId}, Socket ID: ${socket.id})`);
      
      // Notify monitors in the room
      io.to(userRoom).emit('camera-list-update', getCamerasForUser(finalUserId));
    } else if (type === 'monitor') {
      console.log(`Monitor registered: (User ID: ${finalUserId}, Socket ID: ${socket.id})`);
      
      // Send active cameras list to the newly connected monitor
      socket.emit('camera-list-update', getCamerasForUser(finalUserId));
    }
  });

  // Relay WebRTC signalling messages (offer, answer, ice-candidate)
  socket.on('webrtc-signal', ({ targetSocketId, signalData } = {}) => {
    if (!socket.userId || !targetSocketId || !signalData) return;
    
    // Safety check: ensure target exists and belongs to the same user
    const targetSocket = io.sockets.sockets.get(targetSocketId);
    if (targetSocket && targetSocket.userId === socket.userId) {
      targetSocket.emit('webrtc-signal', {
        senderSocketId: socket.id,
        signalData
      });
    }
  });

  // Relay Siren / Alarm commands
  socket.on('trigger-siren', ({ targetSocketId, action } = {}) => {
    if (!socket.userId || !targetSocketId || !['start', 'stop'].includes(action)) return;

    const targetSocket = io.sockets.sockets.get(targetSocketId);
    if (targetSocket && targetSocket.userId === socket.userId && targetSocket.deviceType === 'camera') {
      console.log(`Triggering siren on camera ${targetSocketId}: ${action}`);
      targetSocket.emit('trigger-siren', { action });
    }
  });

  // Forward a camera-facing request only from an authenticated monitor to a
  // registered camera owned by the same user. The camera reports the actual
  // switch result through the Socket.IO acknowledgement.
  socket.on('camera:switch', ({ targetSocketId, facingMode } = {}, acknowledge) => {
    const reply = typeof acknowledge === 'function' ? acknowledge : () => {};
    if (!socket.userId || socket.deviceType !== 'monitor') {
      reply({ success: false, message: 'Only an authenticated monitor can switch a camera.' });
      return;
    }
    if (!targetSocketId || !['user', 'environment'].includes(facingMode)) {
      reply({ success: false, message: 'Choose Front or Back camera.' });
      return;
    }

    const camera = activeCameras[targetSocketId];
    const targetSocket = io.sockets.sockets.get(targetSocketId);
    if (!camera || camera.userId !== socket.userId || !targetSocket
      || targetSocket.userId !== socket.userId || targetSocket.deviceType !== 'camera') {
      reply({ success: false, message: 'That camera is unavailable.' });
      return;
    }

    targetSocket.timeout(10000).emit('camera:switch', { facingMode }, (error, result) => {
      if (error) {
        reply({ success: false, message: 'The camera did not respond. Try again.' });
        return;
      }
      reply(result && typeof result.success === 'boolean'
        ? result
        : { success: false, message: 'The camera returned an invalid response.' });
    });
  });

  // Handle Disconnection
  socket.on('disconnect', () => {
    if (socket.deviceType === 'camera') {
      delete activeCameras[socket.id];
      console.log(`Camera disconnected: "${socket.cameraName}" (Socket ID: ${socket.id})`);
      
      if (socket.userId) {
        const userRoom = `user_${socket.userId}`;
        io.to(userRoom).emit('camera-list-update', getCamerasForUser(socket.userId));
      }
    } else if (socket.deviceType === 'monitor') {
      console.log(`Monitor disconnected: (Socket ID: ${socket.id})`);
    }
  });
});

// Run server
if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`=========================================`);
    console.log(`   Vyntrix backend is up and running!`);
    console.log(`   Local Server: http://localhost:${PORT}`);
    console.log(`=========================================`);
  });
}

module.exports = { app, server };
