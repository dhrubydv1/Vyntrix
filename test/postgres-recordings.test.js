const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const postgresPath = require.resolve('../backend/postgres');
const postgresDbPath = require.resolve('../backend/postgres-db');
const originalPostgresModule = require.cache[postgresPath];
const calls = [];
let queryHandler;

const pool = {
  query(sql, params) {
    calls.push({ sql, params });
    return queryHandler(sql, params);
  }
};

let db;

const row = {
  id: 'recording-1',
  user_id: 'user-1',
  camera_name: 'Front Door',
  object_key: 'recordings/user-1/recording-1.webm',
  content_type: 'video/webm',
  size_bytes: '2048',
  duration_seconds: 12,
  started_at: new Date('2026-09-26T10:00:00.000Z'),
  ended_at: new Date('2026-09-26T10:00:12.000Z'),
  status: 'uploaded',
  created_at: new Date('2026-09-26T10:00:13.000Z')
};

before(() => {
  require.cache[postgresPath] = {
    id: postgresPath,
    filename: postgresPath,
    loaded: true,
    exports: { pool }
  };
  delete require.cache[postgresDbPath];
  db = require('../backend/postgres-db');
});

after(() => {
  delete require.cache[postgresDbPath];
  if (originalPostgresModule) require.cache[postgresPath] = originalPostgresModule;
  else delete require.cache[postgresPath];
});

describe('PostgreSQL recording helpers', () => {
  it('creates metadata only with a parameterized INSERT', async () => {
    calls.length = 0;
    queryHandler = async () => ({ rows: [row] });

    const recording = await db.createRecording({
      userId: 'user-1',
      cameraName: 'Front Door',
      objectKey: 'recordings/user-1/recording-1.webm',
      contentType: 'video/webm',
      sizeBytes: 2048,
      durationSeconds: 12,
      startedAt: '2026-09-26T10:00:00.000Z',
      endedAt: '2026-09-26T10:00:12.000Z'
    });

    assert.match(calls[0].sql, /INSERT INTO recordings/);
    assert.match(calls[0].sql, /VALUES \(\$1, \$2, \$3, \$4, \$5, \$6, \$7, \$8, \$9, \$10\)/);
    assert.strictEqual(calls[0].params[1], 'user-1');
    assert.strictEqual(calls[0].params[3], 'recordings/user-1/recording-1.webm');
    assert.strictEqual(calls[0].params[5], 2048);
    assert.strictEqual(recording.sizeBytes, 2048);
    assert.strictEqual(recording.userId, 'user-1');
    assert.strictEqual(recording.startedAt, '2026-09-26T10:00:00.000Z');
  });

  it('scopes list, read, and delete queries to the authenticated user', async () => {
    calls.length = 0;
    queryHandler = async (sql, params) => {
      if (params[0] !== 'user-1') return { rows: [] };
      return { rows: [row] };
    };

    assert.strictEqual((await db.listRecordingsForUser('user-1')).length, 1);
    assert.strictEqual(await db.getRecordingForUser('user-2', 'recording-1'), null);
    assert.strictEqual(await db.deleteRecordingForUser('user-2', 'recording-1'), null);

    assert.match(calls[0].sql, /WHERE user_id = \$1/);
    assert.match(calls[1].sql, /WHERE user_id = \$1 AND id = \$2/);
    assert.deepStrictEqual(calls[1].params, ['user-2', 'recording-1']);
    assert.match(calls[2].sql, /DELETE FROM recordings[\s\S]*WHERE user_id = \$1 AND id = \$2/);
    assert.deepStrictEqual(calls[2].params, ['user-2', 'recording-1']);
  });

  it('propagates database failures to the API boundary', async () => {
    queryHandler = async () => {
      throw new Error('private database detail');
    };

    await assert.rejects(
      db.listRecordingsForUser('user-1'),
      /private database detail/
    );
  });
});
