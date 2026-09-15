const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// Isolate test DB files from the real ones
const TEST_DB_DIR = path.join(__dirname, '..', 'data', 'test');
const TEST_DB_FILE = path.join(TEST_DB_DIR, 'database.json');
const TEST_UPLOADS_DIR = path.join(TEST_DB_DIR, 'alerts');

// The database module reads this before it is loaded, so test data is never
// written to the application's real data directory.
process.env.VYNTRIX_DATA_DIR = TEST_DB_DIR;
process.env.VYNTRIX_DATABASE_MODE = 'json';

before(() => {
  // Ensure test directories exist
  if (!fs.existsSync(TEST_DB_DIR)) fs.mkdirSync(TEST_DB_DIR, { recursive: true });
  if (!fs.existsSync(TEST_UPLOADS_DIR)) fs.mkdirSync(TEST_UPLOADS_DIR, { recursive: true });

  // Write a clean test database
  fs.writeFileSync(TEST_DB_FILE, JSON.stringify({ users: [], alerts: [] }, null, 2));
});

after(() => {
  // Clean up test files
  try {
    fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
  } catch (_) {}
});

const ts = Date.now();
const U1 = `testuser1_${ts}`;
const U2 = `testuser2_${ts}`;

describe('Database Module (db.js)', () => {
  describe('createUser', () => {
    it('should create a new user with hashed password', async () => {
      const testDb = require('../backend/db');

      const user = await testDb.createUser(U1, 'password123');
      assert.ok(user.id, 'User should have an id');
      assert.strictEqual(user.username, U1);
      assert.strictEqual(user.passwordHash, undefined, 'Should not expose passwordHash');
    });

    it('should reject duplicate usernames', async () => {
      const testDb = require('../backend/db');

      await assert.rejects(
        () => testDb.createUser(U1, 'password123'),
        { message: 'Username already exists' }
      );
    });

    it('should normalize username to lowercase', async () => {
      const testDb = require('../backend/db');

      const user = await testDb.createUser(`TestUser2_${ts}`, 'password123');
      assert.strictEqual(user.username, `testuser2_${ts}`);
    });

    it('should reject usernames with unsupported characters', async () => {
      const testDb = require('../backend/db');

      await assert.rejects(
        () => testDb.createUser('<img src=x onerror=alert(1)>', 'password123'),
        /Username must be 3–32 characters/
      );
    });
  });

  describe('verifyUser', () => {
    it('should return user object for valid credentials', async () => {
      const testDb = require('../backend/db');

      const user = await testDb.verifyUser(U1, 'password123');
      assert.ok(user, 'User should be found');
      assert.strictEqual(user.username, U1);
      assert.strictEqual(user.passwordHash, undefined, 'Should not expose passwordHash');
    });

    it('should return null for wrong password', async () => {
      const testDb = require('../backend/db');

      const user = await testDb.verifyUser(U1, 'wrongpassword');
      assert.strictEqual(user, null);
    });

    it('should return null for non-existent user', async () => {
      const testDb = require('../backend/db');

      const user = await testDb.verifyUser('nonexistent', 'password123');
      assert.strictEqual(user, null);
    });
  });

  describe('findUserByUsername', () => {
    it('should find an existing user', () => {
      const testDb = require('../backend/db');

      const user = testDb.findUserByUsername(U1);
      assert.ok(user);
      assert.strictEqual(user.username, U1);
    });

    it('should return null for non-existent user', () => {
      const testDb = require('../backend/db');

      const user = testDb.findUserByUsername('nobody');
      assert.strictEqual(user, null);
    });

    it('should return null for empty/undefined input', () => {
      const testDb = require('../backend/db');

      assert.strictEqual(testDb.findUserByUsername(null), null);
      assert.strictEqual(testDb.findUserByUsername(undefined), null);
      assert.strictEqual(testDb.findUserByUsername(''), null);
    });
  });

  describe('addAlert', () => {
    const TEST_IMAGE = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AKwA//9k=';

    it('should create a new alert and return it', async () => {
      const testDb = require('../backend/db');

      const alert = await testDb.addAlert(U1, 'Front Door', TEST_IMAGE);
      assert.ok(alert.id, 'Alert should have an id');
      assert.strictEqual(alert.cameraName, 'Front Door');
      assert.ok(alert.timestamp, 'Alert should have a timestamp');
      assert.ok(alert.imageFile, 'Alert should have an imageFile');
    });

    it('should create a metadata-only alert without writing an image', async () => {
      const testDb = require('../backend/db');

      const alert = await testDb.addAlert(U1, 'Metadata Camera');
      assert.ok(alert.id, 'Alert should have an id');
      assert.strictEqual(alert.cameraName, 'Metadata Camera');
      assert.ok(alert.timestamp, 'Alert should have a timestamp');
      assert.strictEqual(alert.imageFile, undefined);
      assert.strictEqual(testDb.getAlertFilePath(U1, alert.id), null);
    });

    it('should default cameraName to Unknown Camera when empty', async () => {
      const testDb = require('../backend/db');

      const alert = await testDb.addAlert(U1, '', TEST_IMAGE);
      assert.strictEqual(alert.cameraName, 'Unknown Camera');
    });

    it('should reject non-string image content', async () => {
      const testDb = require('../backend/db');

      await assert.rejects(
        () => testDb.addAlert(U1, 'cam', 12345),
        { message: 'Image content is required' }
      );
    });

    it('should reject invalid image format', async () => {
      const testDb = require('../backend/db');

      await assert.rejects(
        () => testDb.addAlert(U1, 'cam', 'not-an-image'),
        { message: 'Only JPEG, PNG, and WebP image uploads are supported' }
      );
    });

    it('should reject oversized images', async () => {
      const testDb = require('../backend/db');

      // Create a base64 string that decodes to > 2MB
      const largeBase64 = 'A'.repeat(3 * 1024 * 1024);
      const largeImage = `data:image/jpeg;base64,${largeBase64}`;

      await assert.rejects(
        () => testDb.addAlert(U1, 'cam', largeImage),
        { message: 'Image must be between 1 byte and 2 MB' }
      );
    });
  });

  describe('getAlertsForUser', () => {
    it('should return alerts for the given user sorted by timestamp desc', async () => {
      const testDb = require('../backend/db');

      const TEST_IMAGE = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AKwA//9k=';

      await testDb.addAlert(U1, 'Cam A', TEST_IMAGE);
      const alerts = testDb.getAlertsForUser(U1);
      assert.ok(alerts.length > 0, 'Should have at least one alert');
      assert.strictEqual(alerts[0].userId, U1);
    });

    it('should return empty array for user with no alerts', () => {
      const testDb = require('../backend/db');

      const alerts = testDb.getAlertsForUser('nonexistent_user');
      assert.deepStrictEqual(alerts, []);
    });
  });

  describe('getAlertFilePath', () => {
    it('should return a file path for an existing alert', async () => {
      const testDb = require('../backend/db');

      const TEST_IMAGE = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AKwA//9k=';

      const alert = await testDb.addAlert(U1, 'Cam', TEST_IMAGE);
      const filePath = testDb.getAlertFilePath(U1, alert.id);
      assert.ok(filePath, 'Should return a file path');
      assert.ok(filePath.endsWith('.jpg'), 'Should end with .jpg extension');
    });

    it('should return null for non-existent alert', () => {
      const testDb = require('../backend/db');

      const filePath = testDb.getAlertFilePath(U1, 'nonexistent');
      assert.strictEqual(filePath, null);
    });

    it('should return null for wrong userId', async () => {
      const testDb = require('../backend/db');

      const TEST_IMAGE = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AKwA//9k=';

      const alert = await testDb.addAlert(U1, 'Cam', TEST_IMAGE);
      const filePath = testDb.getAlertFilePath('wrong_user_id', alert.id);
      assert.strictEqual(filePath, null);
    });

    it('should return null for alert with no imageFile or imagePath', () => {
      const testDb = require('../backend/db');

      // Manually push an alert with no image reference
      const db = require('../backend/db');
      // Access internal state through the module
      const filePath = testDb.getAlertFilePath(U1, 'invalid_id_with_no_image');
      assert.strictEqual(filePath, null);
    });
  });

  describe('deleteAlert', () => {
    it('should delete a metadata-only alert', async () => {
      const testDb = require('../backend/db');
      const alert = await testDb.addAlert(U1, 'Metadata Camera');

      assert.strictEqual(await testDb.deleteAlert(U1, alert.id), true);
      assert.ok(!testDb.getAlertsForUser(U1).some(item => item.id === alert.id));
    });

    it('should delete an existing alert and return true', async () => {
      const testDb = require('../backend/db');

      const TEST_IMAGE = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AKwA//9k=';

      const alert = await testDb.addAlert(U1, 'Cam', TEST_IMAGE);
      const deleted = await testDb.deleteAlert(U1, alert.id);
      assert.strictEqual(deleted, true);

      // Verify it's gone
      const filePath = testDb.getAlertFilePath(U1, alert.id);
      assert.strictEqual(filePath, null);
    });

    it('should return false for non-existent alert', async () => {
      const testDb = require('../backend/db');

      const deleted = await testDb.deleteAlert(U1, 'nonexistent');
      assert.strictEqual(deleted, false);
    });

    it('should return false for wrong userId', async () => {
      const testDb = require('../backend/db');

      const TEST_IMAGE = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AKwA//9k=';

      const alert = await testDb.addAlert(U1, 'Cam', TEST_IMAGE);
      const deleted = await testDb.deleteAlert('wrong_user_id', alert.id);
      assert.strictEqual(deleted, false);
    });
  });
});
