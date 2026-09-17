const fs = require('node:fs');
const path = require('node:path');
const bcrypt = require('bcryptjs');
const {
  DATA_DIR,
  MAX_ALERT_IMAGE_BYTES,
  MAX_ALERTS_PER_USER
} = require('./config');
const { pool } = require('./postgres');

// Optional legacy alert images remain local and are served only after ownership checks.
const UPLOADS_DIR = path.join(DATA_DIR, 'alerts');
const USERNAME_PATTERN = /^[a-z0-9._-]{3,32}$/;

function storageError(message, cause, code = 'STORAGE_WRITE_FAILED') {
  const error = new Error(message);
  error.code = code;
  error.cause = cause;
  return error;
}

function ensureWritableDirectory(directory, label) {
  try {
    fs.mkdirSync(directory, { recursive: true });
    fs.accessSync(directory, fs.constants.R_OK | fs.constants.W_OK);
  } catch (error) {
    throw storageError(`${label} is not readable and writable`, error, 'STORAGE_UNAVAILABLE');
  }
}

function init() {
  ensureWritableDirectory(DATA_DIR, 'Runtime data directory');
}

function withoutPasswordHash(user) {
  if (!user) return null;
  const { passwordHash: _, ...userWithoutHash } = user;
  return userWithoutHash;
}

function mapUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    passwordHash: row.password_hash
  };
}

function mapAlert(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    cameraName: row.camera_name,
    timestamp: new Date(row.captured_at).toISOString(),
    ...(row.image_file ? { imageFile: row.image_file } : {}),
    ...(row.image_path ? { imagePath: row.image_path } : {})
  };
}

function validateCredentials(username, password) {
  if (typeof username !== 'string' || !USERNAME_PATTERN.test(username.trim().toLowerCase())) {
    throw new Error('Username must be 3–32 characters and use only letters, numbers, dots, hyphens, or underscores');
  }
  if (typeof password !== 'string' || password.length < 6 || password.length > 128) {
    throw new Error('Password must be between 6 and 128 characters');
  }
}

async function createUser(username, password) {
  validateCredentials(username, password);
  const normalizedUsername = username.trim().toLowerCase();
  const passwordHash = await bcrypt.hash(password, await bcrypt.genSalt(10));

  try {
    const result = await pool.query(
      `INSERT INTO users (id, username, password_hash)
       VALUES ($1, $2, $3)
       RETURNING id, username`,
      [`${Date.now()}${Math.random().toString(36).slice(2, 7)}`, normalizedUsername, passwordHash]
    );
    return result.rows[0];
  } catch (error) {
    if (error.code === '23505') throw new Error('Username already exists');
    throw error;
  }
}

async function findUserByUsername(username) {
  if (!username) return null;
  const result = await pool.query(
    'SELECT id, username, password_hash FROM users WHERE username = $1',
    [username.toLowerCase().trim()]
  );
  return mapUser(result.rows[0]);
}

async function verifyUser(username, password) {
  if (typeof username !== 'string' || typeof password !== 'string') return null;
  const user = await findUserByUsername(username);
  if (!user || !(await bcrypt.compare(password, user.passwordHash))) return null;
  return withoutPasswordHash(user);
}

function parseImage(base64Image) {
  if (base64Image === undefined || base64Image === null) return null;
  if (typeof base64Image !== 'string') throw new Error('Image content is required');
  const matches = base64Image.match(/^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!matches) throw new Error('Only JPEG, PNG, and WebP image uploads are supported');

  const imageBuffer = Buffer.from(matches[2], 'base64');
  if (!imageBuffer.length || imageBuffer.length > MAX_ALERT_IMAGE_BYTES) {
    const maxImageLabel = MAX_ALERT_IMAGE_BYTES === 2 * 1024 * 1024
      ? '2 MB'
      : `${MAX_ALERT_IMAGE_BYTES} bytes`;
    const error = new Error(`Image must be between 1 byte and ${maxImageLabel}`);
    if (imageBuffer.length > MAX_ALERT_IMAGE_BYTES) error.code = 'ALERT_IMAGE_TOO_LARGE';
    throw error;
  }
  return { imageBuffer, extension: matches[1] === 'jpeg' ? 'jpg' : matches[1] };
}

function safeImageFile(alert) {
  const imageFile = alert.image_file || (alert.image_path ? path.basename(alert.image_path) : '');
  return imageFile && /^[a-zA-Z0-9_.-]+$/.test(imageFile) ? imageFile : null;
}

async function addAlert(userId, cameraName, base64Image) {
  const parsedImage = parseImage(base64Image);
  const alertId = `${Date.now()}${Math.random().toString(36).slice(2, 7)}`;
  const imageFile = parsedImage ? `alert_${userId}_${alertId}.${parsedImage.extension}` : null;
  const imagePath = imageFile ? path.join(UPLOADS_DIR, imageFile) : null;
  const alert = {
    id: alertId,
    userId,
    cameraName: typeof cameraName === 'string' && cameraName.trim()
      ? cameraName.trim().slice(0, 64)
      : 'Unknown Camera',
    timestamp: new Date().toISOString(),
    ...(imageFile ? { imageFile } : {})
  };

  let imageWritten = false;
  const client = await pool.connect();
  try {
    if (parsedImage) {
      ensureWritableDirectory(UPLOADS_DIR, 'Alert image directory');
      fs.writeFileSync(imagePath, parsedImage.imageBuffer, { flag: 'wx', mode: 0o600 });
      imageWritten = true;
    }
    await client.query('BEGIN');

    // Serialize retention decisions for this user, including when they have
    // no existing alerts and therefore no alert row to lock.
    await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [userId]);

    const existing = await client.query(
      `SELECT id, image_file, image_path
       FROM alerts
       WHERE user_id = $1
       ORDER BY captured_at ASC, id ASC
       FOR UPDATE`,
      [userId]
    );
    const alertsToRemove = existing.rows.slice(0, Math.max(0, existing.rows.length - MAX_ALERTS_PER_USER + 1));

    await client.query(
      `INSERT INTO alerts
        (id, user_id, camera_name, captured_at, image_file, image_path)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [alert.id, alert.userId, alert.cameraName, alert.timestamp, alert.imageFile, null]
    );

    if (alertsToRemove.length) {
      await client.query(
        'DELETE FROM alerts WHERE user_id = $1 AND id = ANY($2::text[])',
        [userId, alertsToRemove.map(item => item.id)]
      );
    }
    await client.query('COMMIT');

    // Metadata is committed before old image cleanup. Cleanup is best effort.
    for (const oldAlert of alertsToRemove) {
      const oldImageFile = safeImageFile(oldAlert);
      if (oldImageFile) {
        try { fs.rmSync(path.join(UPLOADS_DIR, oldImageFile), { force: true }); } catch (_) {}
      }
    }
    return alert;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if (imageWritten) {
      try { fs.unlinkSync(imagePath); } catch (_) {}
    }
    if (error.code === '23503') throw new Error('Alert owner does not exist');
    if (error.code === 'STORAGE_WRITE_FAILED') throw error;
    throw storageError('Failed to persist alert', error);
  } finally {
    client.release();
  }
}

async function getAlertsForUser(userId) {
  const result = await pool.query(
    `SELECT id, user_id, camera_name, captured_at, image_file, image_path
     FROM alerts
     WHERE user_id = $1
     ORDER BY captured_at DESC, id DESC`,
    [userId]
  );
  return result.rows.map(mapAlert);
}

async function getAlertFilePath(userId, alertId) {
  const result = await pool.query(
    `SELECT image_file, image_path
     FROM alerts
     WHERE id = $1 AND user_id = $2`,
    [alertId, userId]
  );
  const imageFile = result.rows[0] && safeImageFile(result.rows[0]);
  if (!imageFile) return null;
  const privatePath = path.join(UPLOADS_DIR, imageFile);
  return fs.existsSync(privatePath) ? privatePath : null;
}

async function deleteAlert(userId, alertId) {
  const client = await pool.connect();
  let deletedAlert;
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `DELETE FROM alerts
       WHERE id = $1 AND user_id = $2
       RETURNING id, image_file, image_path`,
      [alertId, userId]
    );
    deletedAlert = result.rows[0];
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw storageError('Failed to delete alert', error);
  } finally {
    client.release();
  }

  if (!deletedAlert) return false;
  const imageFile = safeImageFile(deletedAlert);
  if (imageFile) {
    try { fs.rmSync(path.join(UPLOADS_DIR, imageFile), { force: true }); } catch (_) {}
  }
  return true;
}

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
