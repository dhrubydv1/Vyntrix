const fs = require('node:fs/promises');
const path = require('node:path');
const dotenv = require('dotenv');

dotenv.config({
  path: path.join(__dirname, '..', '.env.local'),
  quiet: true
});

const { pool } = require('../backend/postgres');

const DATABASE_FILE = path.join(__dirname, '..', 'data', 'database.json');

function validateCollection(name, value) {
  if (!Array.isArray(value)) {
    throw new Error(`${name} must be an array`);
  }
}

function validateUser(user, index) {
  if (!user || typeof user !== 'object'
    || typeof user.id !== 'string'
    || typeof user.username !== 'string'
    || typeof user.passwordHash !== 'string') {
    throw new Error(`Invalid user record at index ${index}`);
  }
}

function validateAlert(alert, index) {
  if (!alert || typeof alert !== 'object'
    || typeof alert.id !== 'string'
    || typeof alert.userId !== 'string'
    || typeof alert.cameraName !== 'string'
    || typeof alert.timestamp !== 'string') {
    throw new Error(`Invalid alert record at index ${index}`);
  }

  if (alert.imageFile !== undefined && typeof alert.imageFile !== 'string') {
    throw new Error(`Invalid alert imageFile at index ${index}`);
  }

  if (alert.imagePath !== undefined && typeof alert.imagePath !== 'string') {
    throw new Error(`Invalid alert imagePath at index ${index}`);
  }
}

async function readSourceDatabase() {
  const contents = await fs.readFile(DATABASE_FILE, 'utf8');
  let database;

  try {
    database = JSON.parse(contents);
  } catch {
    throw new Error('Source database.json contains malformed JSON');
  }

  validateCollection('users', database?.users);
  validateCollection('alerts', database?.alerts);
  database.users.forEach(validateUser);
  database.alerts.forEach(validateAlert);

  return database;
}

async function migrate() {
  const database = await readSourceDatabase();
  const client = await pool.connect();
  let usersInserted = 0;
  let alertsInserted = 0;

  try {
    await client.query('BEGIN');

    for (const user of database.users) {
      const result = await client.query(
        `INSERT INTO users (id, username, password_hash)
         VALUES ($1, $2, $3)
         ON CONFLICT DO NOTHING`,
        [user.id, user.username, user.passwordHash]
      );
      usersInserted += result.rowCount;
    }

    for (const alert of database.alerts) {
      const result = await client.query(
        `INSERT INTO alerts
          (id, user_id, camera_name, captured_at, image_file, image_path)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT DO NOTHING`,
        [
          alert.id,
          alert.userId,
          alert.cameraName,
          alert.timestamp,
          alert.imageFile ?? null,
          alert.imagePath ?? null
        ]
      );
      alertsInserted += result.rowCount;
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
    await pool.end();
  }

  console.log(`users found: ${database.users.length}`);
  console.log(`users inserted/skipped: ${usersInserted}/${database.users.length - usersInserted}`);
  console.log(`alerts found: ${database.alerts.length}`);
  console.log(`alerts inserted/skipped: ${alertsInserted}/${database.alerts.length - alertsInserted}`);
}

migrate().catch(() => {
  console.error('Migration failed. No committed migration changes were applied.');
  process.exitCode = 1;
});
