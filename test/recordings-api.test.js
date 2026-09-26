const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const { createRecordingsRouter } = require('../backend/recordings-api');

let database;
let storage;
let server;
let baseUrl;

const recordings = [
  {
    id: 'recording-a',
    userId: 'user-a',
    cameraName: 'Hallway',
    objectKey: 'recordings/user-a/recording-a.webm',
    contentType: 'video/webm',
    sizeBytes: 1024,
    durationSeconds: 8,
    startedAt: '2026-09-26T10:00:00.000Z',
    endedAt: '2026-09-26T10:00:08.000Z',
    status: 'uploaded',
    createdAt: '2026-09-26T10:00:09.000Z'
  },
  {
    id: 'recording-b',
    userId: 'user-b',
    cameraName: 'Garage',
    objectKey: 'recordings/user-b/recording-b.webm',
    contentType: 'video/webm',
    sizeBytes: 2048,
    durationSeconds: null,
    startedAt: '2026-09-26T11:00:00.000Z',
    endedAt: null,
    status: 'uploading',
    createdAt: '2026-09-26T11:00:01.000Z'
  }
];

function request(method, route, userId) {
  return new Promise((resolve, reject) => {
    const url = new URL(route, baseUrl);
    const req = http.request(url, {
      method,
      headers: userId ? { 'x-test-user': userId } : {}
    }, (res) => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        resolve({ status: res.statusCode, body: JSON.parse(body) });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function rawRequest(route, userId, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(route, baseUrl);
    const req = http.request(url, {
      method: 'GET',
      headers: {
        ...headers,
        ...(userId ? { 'x-test-user': userId } : {})
      }
    }, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        body: Buffer.concat(chunks),
        headers: res.headers
      }));
    });
    req.on('error', reject);
    req.end();
  });
}

function recordingForm({
  bytes = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x02, 0x03, 0x04]),
  type = 'video/webm',
  extraFields = {}
} = {}) {
  const form = new FormData();
  form.append('recording', new Blob([bytes], { type }), 'recording.webm');
  form.append('cameraName', 'Hallway');
  form.append('startedAt', '2026-09-26T10:00:00.000Z');
  form.append('endedAt', '2026-09-26T10:00:08.000Z');
  form.append('durationSeconds', '8');
  Object.entries(extraFields).forEach(([key, value]) => form.append(key, value));
  return form;
}

async function multipartRequest(form, userId) {
  const response = await fetch(new URL('/api/recordings', baseUrl), {
    method: 'POST',
    headers: userId ? { 'x-test-user': userId } : {},
    body: form
  });
  return { status: response.status, body: await response.json() };
}

before(() => {
  const app = express();
  app.use((req, res, next) => {
    req.session = {};
    const userId = req.get('x-test-user');
    if (userId) req.session.user = { id: userId };
    next();
  });
  const requireAuth = (req, res, next) => {
    if (!req.session.user) return res.status(401).json({ error: 'Unauthorized' });
    return next();
  };
  const dbProxy = new Proxy({}, {
    get: (_, property) => (...args) => database[property](...args)
  });
  app.use('/api/recordings', requireAuth, createRecordingsRouter({
    db: dbProxy,
    loadStorage: () => storage,
    maxUploadBytes: 32
  }));
  server = http.createServer(app);
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

after(() => new Promise(resolve => server.close(resolve)));

beforeEach(() => {
  database = {
    async listRecordingsForUser(userId) {
      return recordings.filter(recording => recording.userId === userId);
    },
    async getRecordingForUser(userId, recordingId) {
      return recordings.find(recording => recording.userId === userId && recording.id === recordingId) || null;
    },
    async deleteRecordingForUser(userId, recordingId) {
      return recordings.find(recording => recording.userId === userId && recording.id === recordingId) || null;
    },
    async createRecording(metadata) {
      return {
        ...metadata,
        id: 'new-recording',
        startedAt: metadata.startedAt.toISOString(),
        endedAt: metadata.endedAt.toISOString(),
        createdAt: '2026-09-26T10:00:09.000Z'
      };
    }
  };
  storage = {
    async uploadRecording() {},
    async getRecording() { return { Body: Buffer.alloc(0) }; },
    async deleteRecording() {}
  };
});

describe('recordings API', () => {
  it('requires authentication', async () => {
    const response = await request('GET', '/api/recordings');
    assert.strictEqual(response.status, 401);
    assert.deepStrictEqual(response.body, { error: 'Unauthorized' });
  });

  it('requires authentication before accepting an upload', async () => {
    const response = await multipartRequest(recordingForm());
    assert.strictEqual(response.status, 401);
    assert.deepStrictEqual(response.body, { error: 'Unauthorized' });
  });

  it('rejects unsupported recording MIME types', async () => {
    const response = await multipartRequest(recordingForm({
      bytes: Buffer.from('not a video'),
      type: 'text/plain'
    }), 'user-a');
    assert.strictEqual(response.status, 415);
    assert.deepStrictEqual(response.body, { error: 'Only WebM and MP4 recordings are supported.' });
  });

  it('rejects recordings over the configured upload limit', async () => {
    const bytes = Buffer.alloc(33);
    Buffer.from([0x1a, 0x45, 0xdf, 0xa3]).copy(bytes);
    const response = await multipartRequest(recordingForm({ bytes }), 'user-a');
    assert.strictEqual(response.status, 413);
    assert.deepStrictEqual(response.body, { error: 'Recording is larger than the upload limit.' });
  });

  it('uploads to a server-generated owner key before inserting metadata', async () => {
    const calls = [];
    let uploadedKey;
    storage.uploadRecording = async upload => {
      uploadedKey = upload.key;
      calls.push('r2-upload');
      assert.strictEqual(upload.contentType, 'video/webm');
      assert.ok(Buffer.isBuffer(upload.body));
    };
    database.createRecording = async metadata => {
      calls.push('db-insert');
      assert.strictEqual(metadata.userId, 'user-a');
      assert.strictEqual(metadata.objectKey, uploadedKey);
      assert.strictEqual(metadata.status, 'uploaded');
      assert.strictEqual(metadata.sizeBytes, 8);
      return {
        ...metadata,
        id: 'new-recording',
        startedAt: metadata.startedAt.toISOString(),
        endedAt: metadata.endedAt.toISOString(),
        createdAt: '2026-09-26T10:00:09.000Z'
      };
    };

    const response = await multipartRequest(recordingForm({
      extraFields: {
        userId: 'user-b',
        objectKey: 'attacker-controlled.webm'
      }
    }), 'user-a');
    assert.strictEqual(response.status, 201);
    assert.deepStrictEqual(calls, ['r2-upload', 'db-insert']);
    assert.match(uploadedKey, /^recordings\/user-a\/2026-09-26\/[0-9a-f-]+\.webm$/);
    assert.notStrictEqual(uploadedKey, 'attacker-controlled.webm');
    assert.strictEqual(response.body.recording.userId, undefined);
  });

  it('does not insert metadata when the R2 upload fails', async () => {
    let metadataInserted = false;
    storage.uploadRecording = async () => { throw new Error('private R2 failure'); };
    database.createRecording = async () => {
      metadataInserted = true;
    };

    const response = await multipartRequest(recordingForm(), 'user-a');
    assert.strictEqual(response.status, 500);
    assert.strictEqual(metadataInserted, false);
    assert.deepStrictEqual(response.body, { error: 'Recording could not be saved. Please try again.' });
  });

  it('deletes the uploaded R2 object when metadata insertion fails', async () => {
    const calls = [];
    let uploadedKey;
    storage.uploadRecording = async ({ key }) => {
      uploadedKey = key;
      calls.push(['upload', key]);
    };
    database.createRecording = async () => {
      calls.push(['insert']);
      throw new Error('private database failure');
    };
    storage.deleteRecording = async key => {
      calls.push(['cleanup', key]);
    };

    const response = await multipartRequest(recordingForm(), 'user-a');
    assert.strictEqual(response.status, 500);
    assert.deepStrictEqual(calls, [
      ['upload', uploadedKey],
      ['insert'],
      ['cleanup', uploadedKey]
    ]);
    assert.ok(!JSON.stringify(response.body).includes('private database failure'));
  });

  it('lists and reads only recordings owned by the current user', async () => {
    const list = await request('GET', '/api/recordings', 'user-a');
    assert.strictEqual(list.status, 200);
    assert.deepStrictEqual(list.body.recordings.map(recording => recording.id), ['recording-a']);
    assert.strictEqual(list.body.recordings[0].userId, undefined);
    assert.strictEqual(list.body.recordings[0].objectKey, undefined);

    const crossUserRead = await request('GET', '/api/recordings/recording-b', 'user-a');
    assert.strictEqual(crossUserRead.status, 404);
    assert.deepStrictEqual(crossUserRead.body, { error: 'Recording not found.' });
  });

  it('requires ownership before requesting playback from R2', async () => {
    let storageReads = 0;
    storage.getRecording = async () => {
      storageReads += 1;
      return { Body: Buffer.alloc(0) };
    };

    const unauthenticated = await request('GET', '/api/recordings/recording-a/content');
    assert.strictEqual(unauthenticated.status, 401);
    const crossUser = await request('GET', '/api/recordings/recording-b/content', 'user-a');
    assert.strictEqual(crossUser.status, 404);
    assert.strictEqual(storageReads, 0);
  });

  it('streams an owned recording and supports normalized byte ranges', async () => {
    const calls = [];
    storage.getRecording = async (key, options) => {
      calls.push([key, options]);
      return { Body: Buffer.alloc(options ? 10 : 1024, 7) };
    };

    const full = await rawRequest('/api/recordings/recording-a/content', 'user-a');
    assert.strictEqual(full.status, 200);
    assert.strictEqual(full.body.length, 1024);
    assert.strictEqual(full.headers['content-type'], 'video/webm');
    assert.strictEqual(full.headers['accept-ranges'], 'bytes');

    const partial = await rawRequest('/api/recordings/recording-a/content', 'user-a', {
      Range: 'bytes=10-19'
    });
    assert.strictEqual(partial.status, 206);
    assert.strictEqual(partial.body.length, 10);
    assert.strictEqual(partial.headers['content-range'], 'bytes 10-19/1024');
    assert.deepStrictEqual(calls, [
      ['recordings/user-a/recording-a.webm', undefined],
      ['recordings/user-a/recording-a.webm', { range: 'bytes=10-19' }]
    ]);
  });

  it('returns a generic playback error and rejects invalid ranges before reading R2', async () => {
    let storageReads = 0;
    storage.getRecording = async () => {
      storageReads += 1;
      throw new Error('private R2 playback failure');
    };

    const response = await request('GET', '/api/recordings/recording-a/content', 'user-a');
    assert.strictEqual(response.status, 503);
    assert.ok(!JSON.stringify(response.body).includes('private R2 playback failure'));
    assert.strictEqual(storageReads, 1);

    storageReads = 0;
    const invalid = await rawRequest('/api/recordings/recording-a/content', 'user-a', {
      Range: 'bytes=2000-3000'
    });
    assert.strictEqual(invalid.status, 416);
    assert.strictEqual(storageReads, 0);
    assert.strictEqual(invalid.headers['content-range'], 'bytes */1024');
  });

  it('returns the same not-found response for absent and other-user recordings', async () => {
    const absent = await request('GET', '/api/recordings/missing', 'user-a');
    const otherUser = await request('GET', '/api/recordings/recording-b', 'user-a');
    assert.strictEqual(absent.status, 404);
    assert.deepStrictEqual(absent.body, otherUser.body);
  });

  it('deletes the R2 object before owner-scoped PostgreSQL metadata', async () => {
    const calls = [];
    database.getRecordingForUser = async (userId, recordingId) => {
      calls.push(['lookup', userId, recordingId]);
      return recordings[0];
    };
    storage.deleteRecording = async objectKey => {
      calls.push(['r2-delete', objectKey]);
    };
    database.deleteRecordingForUser = async (userId, recordingId) => {
      calls.push(['db-delete', userId, recordingId]);
      return recordings[0];
    };

    const response = await request('DELETE', '/api/recordings/recording-a', 'user-a');
    assert.strictEqual(response.status, 200);
    assert.deepStrictEqual(response.body, { success: true });
    assert.deepStrictEqual(calls, [
      ['lookup', 'user-a', 'recording-a'],
      ['r2-delete', 'recordings/user-a/recording-a.webm'],
      ['db-delete', 'user-a', 'recording-a']
    ]);
  });

  it('does not touch R2 when the recording is missing or belongs to another user', async () => {
    let storageCalls = 0;
    storage.deleteRecording = async () => { storageCalls += 1; };

    const response = await request('DELETE', '/api/recordings/recording-b', 'user-a');
    assert.strictEqual(response.status, 404);
    assert.strictEqual(storageCalls, 0);
  });

  it('returns generic errors for database failures', async () => {
    database.listRecordingsForUser = async () => {
      throw new Error('password=private-database-detail');
    };

    const response = await request('GET', '/api/recordings', 'user-a');
    assert.strictEqual(response.status, 500);
    assert.deepStrictEqual(response.body, {
      error: 'Recordings could not be loaded. Please try again.'
    });
    assert.ok(!JSON.stringify(response.body).includes('private-database-detail'));
  });

  it('returns a generic error and stops before metadata deletion when R2 fails', async () => {
    let metadataDeleted = false;
    storage.deleteRecording = async () => {
      throw new Error('secret R2 detail');
    };
    database.deleteRecordingForUser = async () => {
      metadataDeleted = true;
      return recordings[0];
    };

    const response = await request('DELETE', '/api/recordings/recording-a', 'user-a');
    assert.strictEqual(response.status, 500);
    assert.deepStrictEqual(response.body, {
      error: 'Recording could not be deleted. Please try again.'
    });
    assert.strictEqual(metadataDeleted, false);
    assert.ok(!JSON.stringify(response.body).includes('secret R2 detail'));
  });

  it('returns a generic error when metadata deletion fails after R2 deletion', async () => {
    let objectDeleted = false;
    storage.deleteRecording = async () => { objectDeleted = true; };
    database.deleteRecordingForUser = async () => {
      throw new Error('private delete detail');
    };

    const response = await request('DELETE', '/api/recordings/recording-a', 'user-a');
    assert.strictEqual(response.status, 500);
    assert.strictEqual(objectDeleted, true);
    assert.ok(!JSON.stringify(response.body).includes('private delete detail'));
  });
});
