const express = require('express');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const multer = require('multer');

const RECORDING_CONTENT_TYPES = new Map([
  ['video/webm', 'webm'],
  ['video/mp4', 'mp4']
]);
const RECORDING_SIGNATURE_PREFIX_BYTES = 4096;
const RECOGNIZED_ISO_BMFF_BOX_TYPES = new Set([
  'ftyp', 'free', 'skip', 'wide', 'uuid', 'moov', 'mdat', 'styp', 'sidx', 'moof'
]);

// Temporary production diagnostics intentionally exclude messages, request
// data, identifiers, credentials, object keys, and media bytes.
function safeFailureDetails(error) {
  const details = {};
  if (typeof error?.name === 'string') details.name = error.name.slice(0, 80);
  const statusCode = error?.$metadata?.httpStatusCode ?? error?.statusCode ?? error?.status;
  if (Number.isInteger(statusCode)) details.statusCode = statusCode;
  if (typeof error?.code === 'string') details.code = error.code.slice(0, 80);
  return details;
}

function normalizedContentType(contentType) {
  if (typeof contentType !== 'string') return '';
  return contentType.split(';', 1)[0].trim().toLowerCase();
}

function firstRecognizedIsoBmffBoxType(buffer) {
  const prefix = buffer.subarray(0, Math.min(buffer.length, RECORDING_SIGNATURE_PREFIX_BYTES));
  let offset = 0;
  while (offset + 8 <= prefix.length) {
    const boxType = prefix.subarray(offset + 4, offset + 8).toString('ascii');
    if (RECOGNIZED_ISO_BMFF_BOX_TYPES.has(boxType)) return boxType;

    let boxSize = prefix.readUInt32BE(offset);
    let headerSize = 8;
    if (boxSize === 1) {
      if (offset + 16 > prefix.length) return null;
      const extendedSize = prefix.readBigUInt64BE(offset + 8);
      if (extendedSize > BigInt(Number.MAX_SAFE_INTEGER)) return null;
      boxSize = Number(extendedSize);
      headerSize = 16;
    } else if (boxSize === 0) {
      boxSize = buffer.length - offset;
    }
    if (boxSize < headerSize || offset + boxSize > buffer.length) return null;
    offset += boxSize;
  }
  return null;
}

function recordingFormatDiagnostic(buffer, contentType) {
  const normalizedMimeType = normalizedContentType(contentType);
  const ebmlMagicPresent = Buffer.isBuffer(buffer)
    && buffer.length >= 4
    && buffer.readUInt32BE(0) === 0x1a45dfa3;
  const firstIsoBmffBoxType = Buffer.isBuffer(buffer)
    ? firstRecognizedIsoBmffBoxType(buffer)
    : null;
  const detectedContainer = ebmlMagicPresent
    ? 'webm'
    : firstIsoBmffBoxType
      ? 'mp4'
      : 'unknown';
  return {
    normalizedMimeType,
    fileSize: Buffer.isBuffer(buffer) ? buffer.length : 0,
    detectedContainer,
    ...((normalizedMimeType === 'video/mp4' || detectedContainer === 'mp4') && firstIsoBmffBoxType
      ? { firstIsoBmffBoxType }
      : {}),
    ...((normalizedMimeType === 'video/webm' || detectedContainer === 'webm')
      ? { ebmlMagicPresent }
      : {})
  };
}

function readEbmlVint(buffer, offset, preserveMarker = false) {
  if (offset >= buffer.length) return null;
  const firstByte = buffer[offset];
  let width = 1;
  let marker = 0x80;
  while (width <= 8 && !(firstByte & marker)) {
    width += 1;
    marker >>= 1;
  }
  if (width > 8 || offset + width > buffer.length) return null;

  let value = preserveMarker ? firstByte : firstByte & (marker - 1);
  let unknown = !preserveMarker && (firstByte & (marker - 1)) === marker - 1;
  for (let index = 1; index < width; index += 1) {
    value = (value * 256) + buffer[offset + index];
    if (!Number.isSafeInteger(value)) return null;
    if (buffer[offset + index] !== 0xff) unknown = false;
  }
  return { width, value, unknown };
}

function hasValidWebmSignature(prefix) {
  if (prefix.length < 8 || prefix.readUInt32BE(0) !== 0x1a45dfa3) return false;
  const headerSize = readEbmlVint(prefix, 4);
  if (!headerSize || headerSize.unknown || headerSize.value < 1) return false;
  const headerStart = 4 + headerSize.width;
  const headerEnd = headerStart + headerSize.value;
  if (headerEnd > prefix.length) return false;

  let offset = headerStart;
  while (offset < headerEnd) {
    const id = readEbmlVint(prefix, offset, true);
    if (!id || id.width > 4) return false;
    const size = readEbmlVint(prefix, offset + id.width);
    if (!size || size.unknown) return false;
    const valueStart = offset + id.width + size.width;
    const valueEnd = valueStart + size.value;
    if (valueEnd > headerEnd) return false;
    if (id.value === 0x4282) {
      return prefix.subarray(valueStart, valueEnd).toString('ascii').toLowerCase() === 'webm';
    }
    offset = valueEnd;
  }
  return false;
}

function hasValidMp4Signature(prefix, totalSize) {
  let offset = 0;
  while (offset + 8 <= prefix.length) {
    let boxSize = prefix.readUInt32BE(offset);
    const boxType = prefix.subarray(offset + 4, offset + 8).toString('ascii');
    let headerSize = 8;
    if (boxSize === 1) {
      if (offset + 16 > prefix.length) return false;
      const extendedSize = prefix.readBigUInt64BE(offset + 8);
      if (extendedSize > BigInt(Number.MAX_SAFE_INTEGER)) return false;
      boxSize = Number(extendedSize);
      headerSize = 16;
    } else if (boxSize === 0) {
      boxSize = totalSize - offset;
    }
    if (boxSize < headerSize || offset + boxSize > totalSize) return false;

    if (boxType === 'ftyp') {
      if (boxSize < headerSize + 8 || offset + boxSize > prefix.length) return false;
      const majorBrand = prefix.subarray(offset + headerSize, offset + headerSize + 4).toString('ascii');
      const compatibleBrandsBytes = boxSize - headerSize - 8;
      return /^[\x20-\x7e]{4}$/.test(majorBrand) && compatibleBrandsBytes % 4 === 0;
    }
    offset += boxSize;
  }
  return false;
}

function hasValidRecordingSignature(buffer, contentType) {
  if (!Buffer.isBuffer(buffer) || !RECORDING_CONTENT_TYPES.has(contentType)) return false;
  const prefix = buffer.subarray(0, Math.min(buffer.length, RECORDING_SIGNATURE_PREFIX_BYTES));
  if (contentType === 'video/webm') return hasValidWebmSignature(prefix);
  return hasValidMp4Signature(prefix, buffer.length);
}

function parseRecordingTime(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function parseDurationSeconds(value) {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
  const duration = Number(value);
  return Number.isSafeInteger(duration) && duration >= 0 && duration <= 24 * 60 * 60
    ? duration
    : null;
}

function recordingObjectKey(userId, extension, startedAt) {
  const day = startedAt.toISOString().slice(0, 10);
  return `recordings/${encodeURIComponent(userId)}/${day}/${crypto.randomUUID()}.${extension}`;
}

function parseByteRange(value, sizeBytes) {
  if (!value) return null;
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 1) return false;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match || (!match[1] && !match[2])) return false;

  let start;
  let end;
  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength < 1) return false;
    start = Math.max(0, sizeBytes - suffixLength);
    end = sizeBytes - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : sizeBytes - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)
      || start < 0 || start >= sizeBytes || end < start) return false;
    end = Math.min(end, sizeBytes - 1);
  }

  return {
    start,
    end,
    length: end - start + 1,
    value: `bytes=${start}-${end}`
  };
}

async function sendRecordingBody(body, res) {
  if (Buffer.isBuffer(body) || body instanceof Uint8Array) {
    res.end(body);
    return;
  }
  if (body && typeof body.pipe === 'function') {
    await pipeline(body, res);
    return;
  }
  if (body && typeof body.transformToByteArray === 'function') {
    res.end(Buffer.from(await body.transformToByteArray()));
    return;
  }
  throw new Error('Recording storage returned an unsupported response body');
}

function toRecordingResponse(recording) {
  return {
    id: recording.id,
    cameraName: recording.cameraName,
    contentType: recording.contentType,
    sizeBytes: recording.sizeBytes,
    durationSeconds: recording.durationSeconds,
    startedAt: recording.startedAt,
    endedAt: recording.endedAt,
    status: recording.status,
    createdAt: recording.createdAt
  };
}

function createRecordingsRouter({ db, loadStorage, maxUploadBytes = 50 * 1024 * 1024 }) {
  if (!db || typeof loadStorage !== 'function') {
    throw new Error('Recordings API dependencies are required');
  }
  if (!Number.isSafeInteger(maxUploadBytes) || maxUploadBytes < 1) {
    throw new Error('A valid recording upload limit is required');
  }

  const router = express.Router();
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: maxUploadBytes,
      files: 1,
      fields: 6,
      fieldSize: 1024,
      parts: 7
    }
  });

  function acceptRecordingUpload(req, res, next) {
    upload.single('recording')(req, res, (error) => {
      if (!error) return next();
      if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
        console.info('Recording rejected: upload too large');
        return res.status(413).json({ error: 'Recording is larger than the upload limit.' });
      }
      if (error instanceof multer.MulterError) {
        console.info('Recording rejected: invalid multipart upload');
        return res.status(400).json({ error: 'The recording upload is invalid.' });
      }
      console.error('Recording upload parsing failed', safeFailureDetails(error));
      return res.status(500).json({ error: 'Recording could not be uploaded. Please try again.' });
    });
  }

  router.post('/', acceptRecordingUpload, async (req, res) => {
    const file = req.file;
    if (!file || !file.buffer?.length) {
      console.info('Recording rejected: missing file');
      return res.status(400).json({ error: 'A recording file is required.' });
    }

    const contentType = normalizedContentType(file.mimetype);
    const extension = RECORDING_CONTENT_TYPES.get(contentType);
    if (!extension || !hasValidRecordingSignature(file.buffer, contentType)) {
      console.info(
        'Recording rejected: unsupported MIME/signature',
        recordingFormatDiagnostic(file.buffer, contentType)
      );
      return res.status(415).json({ error: 'Only WebM and MP4 recordings are supported.' });
    }

    const startedAt = parseRecordingTime(req.body.startedAt);
    const endedAt = parseRecordingTime(req.body.endedAt);
    const durationSeconds = parseDurationSeconds(req.body.durationSeconds);
    if (!startedAt || !endedAt || endedAt < startedAt || durationSeconds === null) {
      console.info('Recording rejected: invalid timing');
      return res.status(400).json({ error: 'Recording timing information is invalid.' });
    }

    const userId = req.session.user.id;
    const cameraName = typeof req.body.cameraName === 'string' && req.body.cameraName.trim()
      ? req.body.cameraName.trim().slice(0, 255)
      : 'Camera';
    const objectKey = recordingObjectKey(userId, extension, startedAt);
    let uploadCompleted = false;

    try {
      const storage = loadStorage();
      console.info('Recording R2 upload started');
      await storage.uploadRecording({
        key: objectKey,
        body: file.buffer,
        contentType
      });
      uploadCompleted = true;
      console.info('Recording R2 upload succeeded');

      let recording;
      try {
        console.info('Recording metadata save started');
        recording = await db.createRecording({
          userId,
          cameraName,
          objectKey,
          contentType,
          sizeBytes: file.size,
          durationSeconds,
          startedAt,
          endedAt,
          status: 'uploaded'
        });
        console.info('Recording metadata save succeeded');
      } catch (databaseError) {
        try {
          await storage.deleteRecording(objectKey);
        } catch (cleanupError) {
          console.error('Recording R2 cleanup failed', safeFailureDetails(cleanupError));
        }
        throw databaseError;
      }

      return res.status(201).json({ success: true, recording: toRecordingResponse(recording) });
    } catch (error) {
      console.error(
        uploadCompleted ? 'Recording metadata save failed' : 'Recording R2 upload failed',
        safeFailureDetails(error)
      );
      return res.status(500).json({ error: 'Recording could not be saved. Please try again.' });
    }
  });

  router.get('/', async (req, res) => {
    try {
      const recordings = await db.listRecordingsForUser(req.session.user.id);
      return res.json({ recordings: recordings.map(toRecordingResponse) });
    } catch (error) {
      console.error('Failed to list recordings.');
      return res.status(500).json({ error: 'Recordings could not be loaded. Please try again.' });
    }
  });

  router.get('/:id/content', async (req, res) => {
    try {
      const recording = await db.getRecordingForUser(req.session.user.id, req.params.id);
      if (!recording) return res.status(404).json({ error: 'Recording not found.' });

      const range = parseByteRange(req.get('range'), recording.sizeBytes);
      if (range === false) {
        res.setHeader('Content-Range', `bytes */${recording.sizeBytes}`);
        return res.status(416).json({ error: 'Requested recording range is invalid.' });
      }

      const storage = loadStorage();
      const storedObject = await storage.getRecording(
        recording.objectKey,
        range ? { range: range.value } : undefined
      );
      const storedContentType = normalizedContentType(recording.contentType);
      const contentType = RECORDING_CONTENT_TYPES.has(storedContentType)
        ? storedContentType
        : 'application/octet-stream';
      const extension = RECORDING_CONTENT_TYPES.get(contentType) || 'bin';

      res.status(range ? 206 : 200);
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Disposition', `inline; filename="vyntrix-recording.${extension}"`);
      res.setHeader('Content-Length', String(range ? range.length : recording.sizeBytes));
      if (range) res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${recording.sizeBytes}`);
      await sendRecordingBody(storedObject.Body, res);
      return undefined;
    } catch (error) {
      console.error('Failed to stream recording.');
      if (res.headersSent) {
        res.destroy();
        return undefined;
      }
      return res.status(503).json({ error: 'Recording playback is temporarily unavailable.' });
    }
  });

  router.get('/:id', async (req, res) => {
    try {
      const recording = await db.getRecordingForUser(req.session.user.id, req.params.id);
      if (!recording) return res.status(404).json({ error: 'Recording not found.' });
      return res.json({ recording: toRecordingResponse(recording) });
    } catch (error) {
      console.error('Failed to load recording.');
      return res.status(500).json({ error: 'Recording could not be loaded. Please try again.' });
    }
  });

  router.delete('/:id', async (req, res) => {
    try {
      const userId = req.session.user.id;
      const recording = await db.getRecordingForUser(userId, req.params.id);
      if (!recording) return res.status(404).json({ error: 'Recording not found.' });

      const storage = loadStorage();
      await storage.deleteRecording(recording.objectKey);

      const deleted = await db.deleteRecordingForUser(userId, recording.id);
      if (!deleted) {
        console.error('Recording metadata disappeared during deletion.');
        return res.status(500).json({ error: 'Recording could not be deleted. Please try again.' });
      }

      return res.json({ success: true });
    } catch (error) {
      console.error('Failed to delete recording.');
      return res.status(500).json({ error: 'Recording could not be deleted. Please try again.' });
    }
  });

  return router;
}

module.exports = {
  createRecordingsRouter,
  toRecordingResponse,
  safeFailureDetails,
  hasValidRecordingSignature,
  recordingFormatDiagnostic
};
