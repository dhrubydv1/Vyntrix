const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const {
  DATA_DIR: DB_DIR,
  MAX_ALERT_IMAGE_BYTES,
  MAX_ALERTS_PER_USER
} = require('./config');
const DB_FILE = path.join(DB_DIR, 'database.json');
const DB_BACKUP_FILE = `${DB_FILE}.bak`;
const DB_TEMP_FILE = `${DB_FILE}.tmp`;
// Alert images are deliberately kept outside the public directory.  They are
// served only after the requesting user has been authorised by the API.
const UPLOADS_DIR = path.join(DB_DIR, 'alerts');
const SESSIONS_DIR = path.join(DB_DIR, 'sessions');
const USERNAME_PATTERN = /^[a-z0-9._-]{3,32}$/;

// In-memory data store
let db = {
  users: [],
  alerts: []
};
let writeQueue = Promise.resolve();

function storageError(message, cause, code = 'STORAGE_WRITE_FAILED') {
  const error = new Error(message);
  error.code = code;
  error.cause = cause;
  return error;
}

function validateDatabaseShape(candidate) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw storageError('database.json has an invalid structure', null, 'DATABASE_INVALID_SHAPE');
  }
  if (!Array.isArray(candidate.users) || !Array.isArray(candidate.alerts)) {
    throw storageError('database.json is missing required data collections', null, 'DATABASE_INVALID_SHAPE');
  }
  if (candidate.users.some(user => !user || typeof user !== 'object' || typeof user.id !== 'string'
    || typeof user.username !== 'string' || typeof user.passwordHash !== 'string')) {
    throw storageError('database.json contains invalid user records', null, 'DATABASE_INVALID_SHAPE');
  }
  if (candidate.alerts.some(alert => !alert || typeof alert !== 'object' || typeof alert.id !== 'string'
    || typeof alert.userId !== 'string' || typeof alert.timestamp !== 'string')) {
    throw storageError('database.json contains invalid alert records', null, 'DATABASE_INVALID_SHAPE');
  }
  return candidate;
}

function ensureWritableDirectory(directory, label) {
  fs.mkdirSync(directory, { recursive: true });
  try {
    fs.accessSync(directory, fs.constants.R_OK | fs.constants.W_OK);
  } catch (err) {
    throw storageError(`${label} is not readable and writable`, err, 'STORAGE_UNAVAILABLE');
  }
}

function writeDatabaseAtomically() {
  let tempFd;
  try {
    const serialized = JSON.stringify(db, null, 2);
    tempFd = fs.openSync(DB_TEMP_FILE, 'w', 0o600);
    fs.writeFileSync(tempFd, serialized, 'utf8');
    fs.fsyncSync(tempFd);
    fs.closeSync(tempFd);
    tempFd = null;

    // Keep one recoverable copy of the last valid database before replacing it.
    if (fs.existsSync(DB_FILE)) fs.copyFileSync(DB_FILE, DB_BACKUP_FILE);
    fs.renameSync(DB_TEMP_FILE, DB_FILE);
  } catch (err) {
    if (tempFd !== undefined && tempFd !== null) fs.closeSync(tempFd);
    throw storageError('Failed to persist application data', err);
  }
}

function enqueueWrite(operation) {
  const nextWrite = writeQueue.then(operation);
  // A failed write must not permanently block later independent operations.
  writeQueue = nextWrite.catch(() => {});
  return nextWrite;
}

// Initialize DB and folders
function init() {
  ensureWritableDirectory(DB_DIR, 'Runtime data directory');
  ensureWritableDirectory(UPLOADS_DIR, 'Alert image directory');
  ensureWritableDirectory(SESSIONS_DIR, 'Session directory');

  if (fs.existsSync(DB_TEMP_FILE)) {
    throw storageError('A stale database temporary file exists; inspect it before restarting', null, 'STALE_DATABASE_TEMP');
  }

  // Load database from file if it exists
  if (fs.existsSync(DB_FILE)) {
    try {
      const content = fs.readFileSync(DB_FILE, 'utf8');
      db = validateDatabaseShape(JSON.parse(content));
    } catch (err) {
      if (err.code === 'DATABASE_INVALID_SHAPE') {
        console.error('database.json has an invalid structure; refusing to overwrite it.');
        throw err;
      }
      console.error('database.json could not be parsed; refusing to overwrite it.');
      throw storageError('database.json is malformed; refusing to overwrite it', err, 'DATABASE_CORRUPT');
    }
  } else {
    writeDatabaseAtomically();
  }
}

// User Management
async function createUser(username, password) {
  if (typeof username !== 'string' || !USERNAME_PATTERN.test(username.trim().toLowerCase())) {
    throw new Error('Username must be 3–32 characters and use only letters, numbers, dots, hyphens, or underscores');
  }
  if (typeof password !== 'string' || password.length < 6 || password.length > 128) {
    throw new Error('Password must be between 6 and 128 characters');
  }

  const normalizedUsername = username.trim().toLowerCase();
  const salt = await bcrypt.genSalt(10);
  const passwordHash = await bcrypt.hash(password, salt);

  const newUser = {
    id: `${Date.now()}${Math.random().toString(36).slice(2, 7)}`,
    username: normalizedUsername,
    passwordHash
  };

  return enqueueWrite(() => {
    if (findUserByUsername(normalizedUsername)) throw new Error('Username already exists');
    db.users.push(newUser);
    try {
      writeDatabaseAtomically();
    } catch (err) {
      db.users.pop();
      throw err;
    }

    // Return user without password hash
    const { passwordHash: _, ...userWithoutHash } = newUser;
    return userWithoutHash;
  });
}

function findUserByUsername(username) {
  if (!username) return null;
  const lowerName = username.toLowerCase().trim();
  return db.users.find(u => u.username === lowerName) || null;
}

async function verifyUser(username, password) {
  const user = findUserByUsername(username);
  if (!user) return null;

  const match = await bcrypt.compare(password, user.passwordHash);
  if (!match) return null;

  const { passwordHash: _, ...userWithoutHash } = user;
  return userWithoutHash;
}

// Alert / Motion Detection Event Management
async function addAlert(userId, cameraName, base64Image) {
  if (typeof base64Image !== 'string') {
    throw new Error('Image content is required');
  }
  const matches = base64Image.match(/^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!matches) throw new Error('Only JPEG, PNG, and WebP image uploads are supported');

  const imageBuffer = Buffer.from(matches[2], 'base64');
  if (!imageBuffer.length) {
    throw new Error('Image must be between 1 byte and 2 MB');
  }
  if (imageBuffer.length > MAX_ALERT_IMAGE_BYTES) {
    const maxImageLabel = MAX_ALERT_IMAGE_BYTES === 2 * 1024 * 1024
      ? '2 MB'
      : `${MAX_ALERT_IMAGE_BYTES} bytes`;
    const error = new Error(`Image must be between 1 byte and ${maxImageLabel}`);
    error.code = 'ALERT_IMAGE_TOO_LARGE';
    throw error;
  }

  const alertId = `${Date.now()}${Math.random().toString(36).slice(2, 7)}`;
  const extension = matches[1] === 'jpeg' ? 'jpg' : matches[1];
  const imageFile = `alert_${userId}_${alertId}.${extension}`;
  const imagePath = path.join(UPLOADS_DIR, imageFile);
  let imageWritten = false;

  const newAlert = {
    id: alertId,
    userId,
    cameraName: typeof cameraName === 'string' && cameraName.trim()
      ? cameraName.trim().slice(0, 64)
      : 'Unknown Camera',
    timestamp: new Date().toISOString(),
    imageFile
  };

  return enqueueWrite(() => {
    const userAlerts = db.alerts
      .filter(alert => alert.userId === userId)
      .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    const alertsToRemove = userAlerts.slice(0, Math.max(0, userAlerts.length - MAX_ALERTS_PER_USER + 1));
    const originalAlerts = db.alerts;

    try {
      fs.writeFileSync(imagePath, imageBuffer, { flag: 'wx', mode: 0o600 });
      imageWritten = true;
      const removedAlertIds = new Set(alertsToRemove.map(alert => alert.id));
      db.alerts = db.alerts.filter(alert => !removedAlertIds.has(alert.id)).concat(newAlert);
      writeDatabaseAtomically();
    } catch (err) {
      db.alerts = originalAlerts;
      if (imageWritten) {
        try { fs.unlinkSync(imagePath); } catch (_) { /* Preserve the primary error. */ }
      }
      if (err.code === 'STORAGE_WRITE_FAILED') throw err;
      throw storageError('Failed to persist alert image', err);
    }

    // Metadata is committed before retention files are removed. A failed
    // cleanup can leave an orphan, but never leaves a committed record without
    // its new image or removes another user's file.
    alertsToRemove.forEach((alert) => {
      const oldImageFile = alert.imageFile || (alert.imagePath ? path.basename(alert.imagePath) : '');
      if (!oldImageFile || !/^[a-zA-Z0-9_.-]+$/.test(oldImageFile)) return;
      try { fs.rmSync(path.join(UPLOADS_DIR, oldImageFile), { force: true }); } catch (_) { /* Best effort cleanup. */ }
    });
    return newAlert;
  });
}

function getAlertFilePath(userId, alertId) {
  const alert = db.alerts.find(a => a.id === alertId && a.userId === userId);
  if (!alert) return null;

  // imagePath supports alert records created before private storage was added.
  const imageFile = alert.imageFile || (alert.imagePath ? path.basename(alert.imagePath) : '');
  if (!imageFile || !/^[a-zA-Z0-9_.-]+$/.test(imageFile)) return null;

  const privatePath = path.join(UPLOADS_DIR, imageFile);
  return fs.existsSync(privatePath) ? privatePath : null;
}

function getAlertsForUser(userId) {
  return db.alerts
    .filter(a => a.userId === userId)
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
}

async function deleteAlert(userId, alertId) {
  return enqueueWrite(() => {
    const index = db.alerts.findIndex(a => a.id === alertId && a.userId === userId);
    if (index === -1) return false;
    const alert = db.alerts[index];
    db.alerts.splice(index, 1);
    try {
      writeDatabaseAtomically();
    } catch (err) {
      db.alerts.splice(index, 0, alert);
      throw err;
    }

    // Delete the physical file only after metadata persistence succeeds.
    const imageFile = alert.imageFile || (alert.imagePath ? path.basename(alert.imagePath) : '');
    if (imageFile && /^[a-zA-Z0-9_.-]+$/.test(imageFile)) {
      try { fs.rmSync(path.join(UPLOADS_DIR, imageFile), { force: true }); } catch (_) { /* Best effort cleanup. */ }
    }
    return true;
  });
}

// Initialize on require
init();

module.exports = {
  createUser,
  findUserByUsername,
  verifyUser,
  addAlert,
  getAlertsForUser,
  getAlertFilePath,
  deleteAlert
};
