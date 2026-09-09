const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const session = require('express-session');
const FileStore = require('session-file-store')(session);
const rateLimit = require('express-rate-limit');
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env.local') });

const db = require('./db');
const { DATA_DIR } = require('./config');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 2 * 1024 * 1024
});

const PORT = process.env.PORT || 3050;
const isProduction = process.env.NODE_ENV === 'production';

if (isProduction && !process.env.SESSION_SECRET) {
  throw new Error('SESSION_SECRET must be set when NODE_ENV=production');
}

if (isProduction) app.set('trust proxy', 1);

// Session Configuration
const sessionMiddleware = session({
  secret: process.env.SESSION_SECRET || 'development-only-change-this-secret',
  name: 'sasta_cctv_session',
  store: new FileStore({
    path: path.join(DATA_DIR, 'sessions'),
    logFn: () => {}
  }),
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 24 * 60 * 60 * 1000, // 1 day
    httpOnly: true,
    sameSite: 'lax',
    secure: isProduction
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

// Browsers send an Origin header for cross-site form/fetch requests. Reject a
// mismatched value before any state-changing API route to provide CSRF defence
// in addition to the SameSite session cookie.
app.use('/api', (req, res, next) => {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
  const origin = req.get('origin');
  if (!origin || origin === `${req.protocol}://${req.get('host')}`) return next();
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
    res.clearCookie('sasta_cctv_session');
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

// Device APIs
app.get('/api/devices/active-cameras', requireAuth, (req, res) => {
  const cameras = getCamerasForUser(req.session.user.id);
  res.json({ count: cameras.length, cameras });
});

// Alert APIs
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
  if (!image) {
    return res.status(400).json({ error: 'Image content is required' });
  }

  try {
    const alert = db.addAlert(req.session.user.id, cameraName, image);
    const responseAlert = toAlertResponse(alert);
    
    // Broadcast motion alert to monitors in real-time
    const userRoom = `user_${req.session.user.id}`;
    io.to(userRoom).emit('motion-alert', responseAlert);

    return res.json({ success: true, alert: responseAlert });
  } catch (err) {
    console.error('Failed to upload alert:', err);
    return res.status(400).json({ error: err.message || 'Failed to upload alert' });
  }
});

app.delete('/api/alerts/:id', requireAuth, (req, res) => {
  const success = db.deleteAlert(req.session.user.id, req.params.id);
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
  imagePath: `/api/alerts/${encodeURIComponent(alert.id)}/image`
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
server.listen(PORT, () => {
  console.log(`=========================================`);
  console.log(`   Vyntrix backend is up and running!`);
  console.log(`   Local Server: http://localhost:${PORT}`);
  console.log(`=========================================`);
});
