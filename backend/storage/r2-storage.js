const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand
} = require('@aws-sdk/client-s3');

const REQUIRED_ENV_VARS = [
  'R2_BUCKET_NAME',
  'R2_ENDPOINT',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY'
];

function readRequiredConfiguration() {
  const missing = REQUIRED_ENV_VARS.filter((name) => (
    typeof process.env[name] !== 'string' || !process.env[name].trim()
  ));
  if (missing.length) {
    throw new Error(`Cloudflare R2 storage is not configured. Missing: ${missing.join(', ')}`);
  }

  const endpoint = process.env.R2_ENDPOINT.trim().replace(/\/$/, '');
  let parsedEndpoint;
  try {
    parsedEndpoint = new URL(endpoint);
  } catch (_) {
    throw new Error('Cloudflare R2 storage is not configured. R2_ENDPOINT must be a valid HTTPS URL.');
  }
  if (parsedEndpoint.protocol !== 'https:' || parsedEndpoint.origin !== endpoint) {
    throw new Error('Cloudflare R2 storage is not configured. R2_ENDPOINT must be an HTTPS origin without a path.');
  }

  return {
    bucket: process.env.R2_BUCKET_NAME.trim(),
    endpoint,
    accessKeyId: process.env.R2_ACCESS_KEY_ID.trim(),
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY.trim()
  };
}

function validateKey(key) {
  if (typeof key !== 'string' || !key.trim()) {
    throw new TypeError('Recording key must be a non-empty string.');
  }
  return key;
}

const configuration = readRequiredConfiguration();
const client = new S3Client({
  region: 'auto',
  endpoint: configuration.endpoint,
  credentials: {
    accessKeyId: configuration.accessKeyId,
    secretAccessKey: configuration.secretAccessKey
  }
});

function uploadRecording({ key, body, contentType } = {}) {
  const recordingKey = validateKey(key);
  if (body === undefined || body === null) {
    throw new TypeError('Recording body is required.');
  }
  if (typeof contentType !== 'string' || !contentType.trim()) {
    throw new TypeError('Recording contentType must be a non-empty string.');
  }

  return client.send(new PutObjectCommand({
    Bucket: configuration.bucket,
    Key: recordingKey,
    Body: body,
    ContentType: contentType.trim()
  }));
}

function getRecording(key, { range } = {}) {
  if (range !== undefined && (typeof range !== 'string' || !/^bytes=\d+-\d+$/.test(range))) {
    throw new TypeError('Recording range must be a normalized byte range.');
  }
  return client.send(new GetObjectCommand({
    Bucket: configuration.bucket,
    Key: validateKey(key),
    ...(range ? { Range: range } : {})
  }));
}

function deleteRecording(key) {
  return client.send(new DeleteObjectCommand({
    Bucket: configuration.bucket,
    Key: validateKey(key)
  }));
}

async function recordingExists(key) {
  try {
    await client.send(new HeadObjectCommand({
      Bucket: configuration.bucket,
      Key: validateKey(key)
    }));
    return true;
  } catch (error) {
    if (error?.name === 'NotFound'
      || error?.name === 'NoSuchKey'
      || error?.$metadata?.httpStatusCode === 404) {
      return false;
    }
    throw error;
  }
}

module.exports = {
  uploadRecording,
  getRecording,
  deleteRecording,
  recordingExists
};
