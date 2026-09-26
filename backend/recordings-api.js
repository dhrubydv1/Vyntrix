const express = require('express');
const crypto = require('node:crypto');
const multer = require('multer');

const RECORDING_CONTENT_TYPES = new Map([
  ['video/webm', 'webm'],
  ['video/mp4', 'mp4']
]);

function normalizedContentType(contentType) {
  if (typeof contentType !== 'string') return '';
  return contentType.split(';', 1)[0].trim().toLowerCase();
}

function hasValidRecordingSignature(buffer, contentType) {
  if (!Buffer.isBuffer(buffer)) return false;
  if (contentType === 'video/webm') {
    return buffer.length >= 4
      && buffer[0] === 0x1a
      && buffer[1] === 0x45
      && buffer[2] === 0xdf
      && buffer[3] === 0xa3;
  }
  if (contentType === 'video/mp4') {
    return buffer.length >= 12 && buffer.subarray(4, 8).toString('ascii') === 'ftyp';
  }
  return false;
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

function toRecordingResponse(recording) {
  return {
    id: recording.id,
    cameraName: recording.cameraName,
    objectKey: recording.objectKey,
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
        return res.status(413).json({ error: 'Recording is larger than the upload limit.' });
      }
      if (error instanceof multer.MulterError) {
        return res.status(400).json({ error: 'The recording upload is invalid.' });
      }
      console.error('Failed to parse recording upload.');
      return res.status(500).json({ error: 'Recording could not be uploaded. Please try again.' });
    });
  }

  router.post('/', acceptRecordingUpload, async (req, res) => {
    const file = req.file;
    if (!file || !file.buffer?.length) {
      return res.status(400).json({ error: 'A recording file is required.' });
    }

    const contentType = normalizedContentType(file.mimetype);
    const extension = RECORDING_CONTENT_TYPES.get(contentType);
    if (!extension || !hasValidRecordingSignature(file.buffer, contentType)) {
      return res.status(415).json({ error: 'Only WebM and MP4 recordings are supported.' });
    }

    const startedAt = parseRecordingTime(req.body.startedAt);
    const endedAt = parseRecordingTime(req.body.endedAt);
    const durationSeconds = parseDurationSeconds(req.body.durationSeconds);
    if (!startedAt || !endedAt || endedAt < startedAt || durationSeconds === null) {
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
      await storage.uploadRecording({
        key: objectKey,
        body: file.buffer,
        contentType
      });
      uploadCompleted = true;

      let recording;
      try {
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
      } catch (databaseError) {
        try {
          await storage.deleteRecording(objectKey);
        } catch (cleanupError) {
          console.error('Failed to clean up an uploaded recording after metadata failure.');
        }
        throw databaseError;
      }

      return res.status(201).json({ success: true, recording: toRecordingResponse(recording) });
    } catch (error) {
      console.error(uploadCompleted ? 'Failed to save recording metadata.' : 'Failed to upload recording.');
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

module.exports = { createRecordingsRouter, toRecordingResponse };
