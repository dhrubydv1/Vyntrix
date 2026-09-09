const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { DATA_DIR: DB_DIR } = require('./config');
const DB_FILE = path.join(DB_DIR, 'database.json');
// Alert images are deliberately kept outside the public directory.  They are
// served only after the requesting user has been authorised by the API.
const UPLOADS_DIR = path.join(DB_DIR, 'alerts');
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
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
      console.error('Failed to parse database.json, starting fresh:', err);
      save();
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
  save();

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
  if (!imageBuffer.length || imageBuffer.length > MAX_IMAGE_BYTES) {
    throw new Error('Image must be between 1 byte and 2 MB');
  }

  const alertId = `${Date.now()}${Math.random().toString(36).slice(2, 7)}`;
  const extension = matches[1] === 'jpeg' ? 'jpg' : matches[1];
  const imageFile = `alert_${userId}_${alertId}.${extension}`;
  fs.writeFileSync(path.join(UPLOADS_DIR, imageFile), imageBuffer, { flag: 'wx' });

  const newAlert = {
    id: alertId,
    userId,
    cameraName: typeof cameraName === 'string' && cameraName.trim()
      ? cameraName.trim().slice(0, 64)
      : 'Unknown Camera',
    timestamp: new Date().toISOString(),
    imageFile
  };

  db.alerts.push(newAlert);
  save();

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
    // Delete physical file if it exists
    if (alert.imageFile || alert.imagePath) {
      const imageFile = alert.imageFile || path.basename(alert.imagePath);
      const filePath = path.join(UPLOADS_DIR, imageFile);
      if (fs.existsSync(filePath)) {
        try {
          fs.unlinkSync(filePath);
        } catch (err) {
          console.error('Failed to delete physical file:', err);
        }
      }
    }
    db.alerts.splice(index, 1);
    save();
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
