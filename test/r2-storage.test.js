const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand
} = require('@aws-sdk/client-s3');

const adapterPath = path.join(__dirname, '..', 'backend', 'storage', 'r2-storage.js');
const environmentNames = [
  'R2_BUCKET_NAME',
  'R2_ENDPOINT',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY'
];
const originalEnvironment = Object.fromEntries(environmentNames.map((name) => [name, process.env[name]]));
const originalSend = S3Client.prototype.send;

function clearAdapterCache() {
  delete require.cache[require.resolve(adapterPath)];
}

function configureTestEnvironment() {
  process.env.R2_BUCKET_NAME = 'test-recordings';
  process.env.R2_ENDPOINT = 'https://example-account.r2.cloudflarestorage.com';
  process.env.R2_ACCESS_KEY_ID = 'test-access-key';
  process.env.R2_SECRET_ACCESS_KEY = 'test-secret-key';
}

beforeEach(() => {
  configureTestEnvironment();
  clearAdapterCache();
});

afterEach(() => {
  S3Client.prototype.send = originalSend;
  for (const name of environmentNames) {
    if (originalEnvironment[name] === undefined) delete process.env[name];
    else process.env[name] = originalEnvironment[name];
  }
  clearAdapterCache();
});

describe('Cloudflare R2 storage adapter', () => {
  it('reports every missing required environment variable without exposing credentials', () => {
    environmentNames.forEach((name) => delete process.env[name]);

    assert.throws(
      () => require(adapterPath),
      (error) => {
        assert.match(error.message, /Cloudflare R2 storage is not configured/);
        environmentNames.forEach((name) => assert.match(error.message, new RegExp(name)));
        assert.ok(!error.message.includes('test-secret-key'));
        return true;
      }
    );
  });

  it('uploads a recording with the configured bucket and content type', async () => {
    const calls = [];
    const expectedResponse = { ETag: 'mock-etag' };
    S3Client.prototype.send = async (command) => {
      calls.push(command);
      return expectedResponse;
    };
    const storage = require(adapterPath);
    const body = Buffer.from('recording');

    const result = await storage.uploadRecording({
      key: 'recordings/camera-1/clip.webm',
      body,
      contentType: 'video/webm'
    });

    assert.strictEqual(result, expectedResponse);
    assert.strictEqual(calls.length, 1);
    assert.ok(calls[0] instanceof PutObjectCommand);
    assert.deepStrictEqual(calls[0].input, {
      Bucket: 'test-recordings',
      Key: 'recordings/camera-1/clip.webm',
      Body: body,
      ContentType: 'video/webm'
    });
  });

  it('gets and deletes recordings without transforming SDK responses', async () => {
    const calls = [];
    const responses = [{ Body: { mocked: true } }, { DeleteMarker: true }];
    S3Client.prototype.send = async (command) => {
      calls.push(command);
      return responses[calls.length - 1];
    };
    const storage = require(adapterPath);

    assert.strictEqual(await storage.getRecording('recordings/clip.webm'), responses[0]);
    assert.strictEqual(await storage.deleteRecording('recordings/clip.webm'), responses[1]);
    assert.ok(calls[0] instanceof GetObjectCommand);
    assert.ok(calls[1] instanceof DeleteObjectCommand);
    assert.deepStrictEqual(calls.map((command) => command.input), [
      { Bucket: 'test-recordings', Key: 'recordings/clip.webm' },
      { Bucket: 'test-recordings', Key: 'recordings/clip.webm' }
    ]);
  });

  it('forwards a validated byte range when streaming a recording', async () => {
    let command;
    S3Client.prototype.send = async (sentCommand) => {
      command = sentCommand;
      return { Body: Buffer.from('clip') };
    };
    const storage = require(adapterPath);

    await storage.getRecording('recordings/clip.webm', { range: 'bytes=10-19' });
    assert.ok(command instanceof GetObjectCommand);
    assert.deepStrictEqual(command.input, {
      Bucket: 'test-recordings',
      Key: 'recordings/clip.webm',
      Range: 'bytes=10-19'
    });
    assert.throws(
      () => storage.getRecording('recordings/clip.webm', { range: 'bytes=10-' }),
      /normalized byte range/
    );
  });

  it('checks recording existence and treats only not-found responses as false', async () => {
    const calls = [];
    S3Client.prototype.send = async (command) => {
      calls.push(command);
      if (calls.length === 2) {
        const error = new Error('not found');
        error.$metadata = { httpStatusCode: 404 };
        throw error;
      }
      return {};
    };
    const storage = require(adapterPath);

    assert.strictEqual(await storage.recordingExists('recordings/present.webm'), true);
    assert.strictEqual(await storage.recordingExists('recordings/missing.webm'), false);
    assert.ok(calls.every((command) => command instanceof HeadObjectCommand));
  });

  it('validates recording inputs before sending a request', async () => {
    let sends = 0;
    S3Client.prototype.send = async () => { sends += 1; };
    const storage = require(adapterPath);

    assert.throws(() => storage.uploadRecording(), /Recording key/);
    assert.throws(
      () => storage.uploadRecording({ key: 'recordings/clip.webm', contentType: 'video/webm' }),
      /Recording body/
    );
    assert.throws(
      () => storage.uploadRecording({ key: 'recordings/clip.webm', body: Buffer.alloc(0) }),
      /contentType/
    );
    assert.throws(() => storage.getRecording(''), /Recording key/);
    assert.strictEqual(sends, 0);
  });
});
