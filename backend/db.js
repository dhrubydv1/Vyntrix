const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const {
  DATA_DIR: DB_DIR,
  MAX_ALERT_IMAGE_BYTES,
  MAX_ALERTS_PER_USER
} = require('./config');
const DB_FILE = path.join(DB_DIR, 'database.json');
// Alert images are deliberately kept outside the public directory.  They are
// served only after the requesting user has been authorised by the API.
const UPLOADS_DIR = path.join(DB_DIR, 'alerts');
const USERNAME_PATTERN = /^[a-z0-9._-]{3,32}$/;

// In-memory data store
let db = {
  users: [],
  alerts: []
};

// Initialize DB and folders
function init() {
  // Ensure DB directory exists
  if (!fs.existsSync(DB_DIR)) {
    fs.mkdirSync(DB_DIR, { recursive: true });
  }

  // Ensure uploads directory exists
  if (!fs.existsSync(UPLOADS_DIR)) {
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  }

  // Load database from file if it exists
  if (fs.existsSync(DB_FILE)) {
    try {
      const content = fs.readFileSync(DB_FILE, 'utf8');
      db = JSON.parse(content);
      // Double check sections exist
      db.users = db.users || [];
      db.alerts = db.alerts || [];
    } catch (err) {
      console.error('Failed to parse database.json; refusing to overwrite the existing file:', err);
      throw err;
    }
  } else {
    save();
  }
}

// Save database to file
function save() {
  try {
    const tempFile = `${DB_FILE}.tmp`;
    fs.writeFileSync(tempFile, JSON.stringify(db, null, 2), 'utf8');
    fs.renameSync(tempFile, DB_FILE);
  } catch (err) {
    console.error('Failed to save database.json:', err);
    const storageError = new Error('Failed to persist application data');
    storageError.code = 'STORAGE_WRITE_FAILED';
    storageError.cause = err;
    throw storageError;
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
  const existingUser = findUserByUsername(normalizedUsername);
  if (existingUser) {
    throw new Error('Username already exists');
  }

  const salt = await bcrypt.genSalt(10);
  const passwordHash = await bcrypt.hash(password, salt);

  const newUser = {
    id: `${Date.now()}${Math.random().toString(36).slice(2, 7)}`,
    username: normalizedUsername,
    passwordHash
  };

  db.users.push(newUser);
  try {
    save();
  } catch (err) {
    db.users.pop();
    throw err;
  }

  // Return user without password hash
  const { passwordHash: _, ...userWithoutHash } = newUser;
  return userWithoutHash;
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
function addAlert(userId, cameraName, base64Image) {
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

  const userAlerts = db.alerts
    .filter(alert => alert.userId === userId)
    .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  const alertsToRemove = userAlerts.slice(
    0,
    Math.max(0, userAlerts.length - MAX_ALERTS_PER_USER + 1)
  );
  const originalAlerts = db.alerts;

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

  try {
    fs.writeFileSync(imagePath, imageBuffer, { flag: 'wx' });
    imageWritten = true;

    const removedAlertIds = new Set(alertsToRemove.map(alert => alert.id));
    db.alerts = db.alerts
      .filter(alert => !removedAlertIds.has(alert.id))
      .concat(newAlert);
    save();
  } catch (err) {
    db.alerts = originalAlerts;
    if (imageWritten) {
      try {
        fs.unlinkSync(imagePath);
      } catch (cleanupError) {
        console.error('Failed to clean up an unsaved alert image:', cleanupError);
      }
    }
    if (err.code === 'STORAGE_WRITE_FAILED') throw err;
    const storageError = new Error('Failed to persist alert image');
    storageError.code = 'STORAGE_WRITE_FAILED';
    storageError.cause = err;
    throw storageError;
  }

  // Retention removes the oldest user-owned alerts after the new record is
  // safely persisted. A failed cleanup leaves an orphaned file, but never
  // exposes another user's data or prevents the alert metadata from loading.
  alertsToRemove.forEach((alert) => {
    const oldImageFile = alert.imageFile || (alert.imagePath ? path.basename(alert.imagePath) : '');
    if (!oldImageFile || !/^[a-zA-Z0-9_.-]+$/.test(oldImageFile)) return;
    const oldImagePath = path.join(UPLOADS_DIR, oldImageFile);
    if (fs.existsSync(oldImagePath)) {
      try {
        fs.unlinkSync(oldImagePath);
      } catch (err) {
        console.error('Failed to delete retained alert image:', err);
      }
    }
  });

  return newAlert;
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

function deleteAlert(userId, alertId) {
  const index = db.alerts.findIndex(a => a.id === alertId && a.userId === userId);
  if (index !== -1) {
    const alert = db.alerts[index];
    db.alerts.splice(index, 1);
    try {
      save();
    } catch (err) {
      db.alerts.splice(index, 0, alert);
      throw err;
    }

    // Delete the physical file only after metadata persistence succeeds.
    if (alert.imageFile || alert.imagePath) {
      const imageFile = alert.imageFile || path.basename(alert.imagePath);
      if (/^[a-zA-Z0-9_.-]+$/.test(imageFile)) {
        const filePath = path.join(UPLOADS_DIR, imageFile);
        if (fs.existsSync(filePath)) {
          try {
            fs.unlinkSync(filePath);
          } catch (err) {
            console.error('Failed to delete physical file:', err);
          }
        }
      }
    }
    return true;
  }
  return false;
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
