const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.join(__dirname, '..');
const monitorHtml = fs.readFileSync(path.join(projectRoot, 'public', 'monitor.html'), 'utf8');
const monitorScript = fs.readFileSync(path.join(projectRoot, 'public', 'js', 'monitor.js'), 'utf8');
const cameraScript = fs.readFileSync(path.join(projectRoot, 'public', 'js', 'camera.js'), 'utf8');

describe('remote recording frontend wiring', () => {
  it('provides accessible remote recording controls and elapsed state', () => {
    assert.match(monitorHtml, /id="btn-start-remote-recording"/);
    assert.match(monitorHtml, /id="btn-stop-remote-recording"/);
    assert.match(monitorHtml, /id="remote-recording-elapsed"/);
    assert.match(monitorHtml, /id="remote-recording-state"/);
    assert.match(monitorHtml, /id="remote-recording-quality"/);
    assert.match(monitorHtml, /id="remote-recording-quality-estimate"/);
    assert.match(monitorHtml, /aria-live="polite"/);
  });

  it('uses Socket.IO state sync and guards duplicate monitor commands', () => {
    assert.match(monitorScript, /remoteRecordingCommandInProgress/);
    assert.match(monitorScript, /emit\('recording:control'/);
    assert.match(monitorScript, /emit\('recording:state-request'/);
    assert.match(monitorScript, /on\('recording:state'/);
    assert.match(monitorScript, /remoteRecordingState === 'recording' \|\| remoteRecordingState === 'uploading'/);
    assert.match(monitorScript, /\/api\/recordings\/storage/);
    assert.match(monitorScript, /No space available\. Delete old recordings to continue\./);
    assert.match(monitorScript, /on\('camera:quality'/);
  });

  it('keeps MediaRecorder on the camera and reuses its recording functions', () => {
    assert.doesNotMatch(monitorScript, /new MediaRecorder/);
    assert.match(cameraScript, /on\('recording:control'/);
    assert.match(cameraScript, /reply\(await startRecording\(\)\)/);
    assert.match(cameraScript, /void stopRecording\(\)/);
    assert.match(cameraScript, /MediaRecorder MIME type selected/);
    assert.match(cameraScript, /\/api\/recordings\/storage/);
    assert.match(cameraScript, /No space available\. Delete old recordings to continue\./);
  });
});
