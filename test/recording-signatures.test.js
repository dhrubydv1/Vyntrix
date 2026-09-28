const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  hasValidRecordingSignature,
  recordingFormatDiagnostic,
  resolveRecordingFormat
} = require('../backend/recordings-api');

function bmffBox(type, payload = Buffer.alloc(0)) {
  const box = Buffer.alloc(8 + payload.length);
  box.writeUInt32BE(box.length, 0);
  box.write(type, 4, 4, 'ascii');
  payload.copy(box, 8);
  return box;
}

describe('browser recording signature validation', () => {
  it('accepts an Android-style WebM EBML header', () => {
    const androidWebm = Buffer.from(
      '1a45dfa39f4286810142f7810142f2810442f381084282847765626d428781044285810218538067ff',
      'hex'
    );

    assert.strictEqual(hasValidRecordingSignature(androidWebm, 'video/webm'), true);
  });

  it('accepts MP4 when a valid ftyp box follows a leading box', () => {
    const leadingFreeBox = bmffBox('free', Buffer.from([0, 0, 0, 0]));
    const ftypPayload = Buffer.concat([
      Buffer.from('isom', 'ascii'),
      Buffer.from([0, 0, 2, 0]),
      Buffer.from('isommp42', 'ascii')
    ]);
    const mp4 = Buffer.concat([leadingFreeBox, bmffBox('ftyp', ftypPayload), bmffBox('mdat')]);

    assert.notStrictEqual(mp4.indexOf('ftyp'), 4);
    assert.strictEqual(hasValidRecordingSignature(mp4, 'video/mp4'), true);
  });

  it('rejects malformed and random payloads', () => {
    assert.strictEqual(hasValidRecordingSignature(Buffer.from('random browser bytes'), 'video/webm'), false);
    assert.strictEqual(hasValidRecordingSignature(Buffer.from('0000000866747970', 'hex'), 'video/mp4'), false);
    assert.strictEqual(hasValidRecordingSignature(Buffer.from('ftyp hidden in random bytes'), 'video/mp4'), false);
  });

  it('rejects mismatched MIME types and signatures', () => {
    const webm = Buffer.from('1a45dfa3874282847765626d', 'hex');
    const mp4 = bmffBox('ftyp', Buffer.concat([
      Buffer.from('isom', 'ascii'),
      Buffer.alloc(4)
    ]));

    assert.strictEqual(hasValidRecordingSignature(webm, 'video/mp4'), false);
    assert.strictEqual(hasValidRecordingSignature(mp4, 'video/webm'), false);
  });

  it('reports only safe WebM rejection diagnostics', () => {
    const malformedWebm = Buffer.from('1a45dfa300000000', 'hex');

    assert.deepStrictEqual(recordingFormatDiagnostic(malformedWebm, 'video/webm;codecs=vp8,opus'), {
      normalizedMimeType: 'video/webm',
      fileSize: malformedWebm.length,
      detectedContainer: 'webm',
      ebmlMagicPresent: true
    });
  });

  it('reports only the first recognized MP4 box type', () => {
    const malformedFtyp = Buffer.from('0000000866747970', 'hex');

    assert.deepStrictEqual(recordingFormatDiagnostic(malformedFtyp, 'video/mp4'), {
      normalizedMimeType: 'video/mp4',
      fileSize: malformedFtyp.length,
      detectedContainer: 'mp4',
      firstIsoBmffBoxType: 'ftyp'
    });
  });

  it('classifies unrecognized bytes without exposing their contents', () => {
    const randomPayload = Buffer.from('private bytes must not appear');
    const diagnostic = recordingFormatDiagnostic(randomPayload, 'application/octet-stream');

    assert.deepStrictEqual(diagnostic, {
      normalizedMimeType: 'application/octet-stream',
      fileSize: randomPayload.length,
      detectedContainer: 'unknown'
    });
    assert.ok(!JSON.stringify(diagnostic).includes('private'));
  });

  it('allows only explicit matches or known generic browser MIME values', () => {
    const webm = Buffer.from(
      '1a45dfa39f4286810142f7810142f2810442f381084282847765626d428781044285810218538067ff',
      'hex'
    );

    assert.strictEqual(resolveRecordingFormat(webm, 'text/plain').contentType, 'video/webm');
    assert.strictEqual(resolveRecordingFormat(webm, 'application/octet-stream').contentType, 'video/webm');
    assert.strictEqual(resolveRecordingFormat(webm, '').contentType, 'video/webm');
    assert.strictEqual(resolveRecordingFormat(webm, 'video/webm').contentType, 'video/webm');
    assert.strictEqual(resolveRecordingFormat(webm, 'video/mp4'), null);
    assert.strictEqual(resolveRecordingFormat(webm, 'application/x-custom-video'), null);
    assert.strictEqual(resolveRecordingFormat(Buffer.from('random'), 'text/plain'), null);
  });
});
