const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const projectRoot = path.join(__dirname, '..');
process.env.VYNTRIX_DATABASE_MODE = 'json';
const image = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMCwsKCwsMDQ4SEA0OEQ4LCxAWEBETFBUVFQ4PFx8WFBgSFBUU/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBL/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAb/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AKwA//9k=';

function makeRuntimeDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vyntrix-persistence-'));
}

function runNode(script, dataDir) {
  return execFileSync(process.execPath, ['-e', script], {
    cwd: projectRoot,
    env: { ...process.env, VYNTRIX_DATA_DIR: dataDir },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

function removeRuntimeDir(dataDir) {
  fs.rmSync(dataDir, { recursive: true, force: true });
}

describe('Single-node persistence hardening', () => {
  it('serializes rapid writes without losing either user', () => {
    const dataDir = makeRuntimeDir();
    try {
      const result = JSON.parse(runNode(`
        const db = require('./backend/db');
        Promise.all([
          db.createUser('rapidone', 'password123'),
          db.createUser('rapidtow', 'password123')
        ]).then(() => {
          process.stdout.write(JSON.stringify(JSON.parse(require('fs').readFileSync(require('path').join(process.env.VYNTRIX_DATA_DIR, 'database.json'))).users.map(user => user.username)));
        }).catch(error => { console.error(error); process.exitCode = 1; });
      `, dataDir));
      assert.deepStrictEqual(result.sort(), ['rapidone', 'rapidtow']);
    } finally {
      removeRuntimeDir(dataDir);
    }
  });

  it('creates one backup containing the previous valid database', () => {
    const dataDir = makeRuntimeDir();
    try {
      runNode(`
        const db = require('./backend/db');
        db.createUser('backupone', 'password123').then(() => db.createUser('backuptwo', 'password123')).catch(error => { console.error(error); process.exitCode = 1; });
      `, dataDir);
      const backup = JSON.parse(fs.readFileSync(path.join(dataDir, 'database.json.bak'), 'utf8'));
      assert.strictEqual(backup.users.length, 1);
      assert.strictEqual(fs.existsSync(path.join(dataDir, 'database.json.tmp')), false);
    } finally {
      removeRuntimeDir(dataDir);
    }
  });

  it('preserves users, alerts, and ownership across a fresh process', () => {
    const dataDir = makeRuntimeDir();
    try {
      runNode(`
        const db = require('./backend/db');
        db.createUser('restartuser', 'password123')
          .then(user => db.addAlert(user.id, 'Restart Camera', ${JSON.stringify(image)}))
          .catch(error => { console.error(error); process.exitCode = 1; });
      `, dataDir);
      const result = JSON.parse(runNode(`
        const db = require('./backend/db');
        const user = db.findUserByUsername('restartuser');
        process.stdout.write(JSON.stringify({
          users: user ? 1 : 0,
          alerts: user ? db.getAlertsForUser(user.id).length : 0,
          owner: user ? db.getAlertsForUser(user.id)[0].userId === user.id : false
        }));
      `, dataDir));
      assert.deepStrictEqual(result, { users: 1, alerts: 1, owner: true });
    } finally {
      removeRuntimeDir(dataDir);
    }
  });

  it('preserves malformed database content and refuses startup', () => {
    const dataDir = makeRuntimeDir();
    const databaseFile = path.join(dataDir, 'database.json');
    const original = '{"users": [';
    try {
      fs.writeFileSync(databaseFile, original);
      assert.throws(() => runNode("require('./backend/db')", dataDir));
      assert.strictEqual(fs.readFileSync(databaseFile, 'utf8'), original);
    } finally {
      removeRuntimeDir(dataDir);
    }
  });

  it('refuses invalid database shape without replacing it', () => {
    const dataDir = makeRuntimeDir();
    const databaseFile = path.join(dataDir, 'database.json');
    const original = JSON.stringify({ users: {}, alerts: [] });
    try {
      fs.writeFileSync(databaseFile, original);
      assert.throws(() => runNode("require('./backend/db')", dataDir));
      assert.strictEqual(fs.readFileSync(databaseFile, 'utf8'), original);
    } finally {
      removeRuntimeDir(dataDir);
    }
  });

  it('propagates a failed atomic replacement and rolls back an alert image', () => {
    const dataDir = makeRuntimeDir();
    try {
      const result = JSON.parse(runNode(`
        const fs = require('fs');
        const db = require('./backend/db');
        fs.renameSync = () => { throw new Error('simulated replacement failure'); };
        db.addAlert('rollback-user', 'Camera', ${JSON.stringify(image)})
          .then(() => process.exitCode = 1)
          .catch(error => {
            const files = fs.readdirSync(require('path').join(process.env.VYNTRIX_DATA_DIR, 'alerts'));
            process.stdout.write(JSON.stringify({ code: error.code, files, alerts: JSON.parse(fs.readFileSync(require('path').join(process.env.VYNTRIX_DATA_DIR, 'database.json'))).alerts }));
          });
      `, dataDir));
      assert.strictEqual(result.code, 'STORAGE_WRITE_FAILED');
      assert.deepStrictEqual(result.alerts, []);
      assert.deepStrictEqual(result.files, []);
    } finally {
      removeRuntimeDir(dataDir);
    }
  });

  it('starts without requiring an alert image directory', () => {
    const dataDir = makeRuntimeDir();
    removeRuntimeDir(dataDir);
    try {
      runNode("require('./backend/db')", dataDir);
      assert.ok(fs.existsSync(path.join(dataDir, 'database.json')));
      assert.ok(!fs.existsSync(path.join(dataDir, 'alerts')));
      assert.ok(fs.existsSync(path.join(dataDir, 'sessions')));
    } finally {
      removeRuntimeDir(dataDir);
    }
  });
});
