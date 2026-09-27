const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { hasValidRecordingSignature } = require('../backend/recordings-api');

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
});
