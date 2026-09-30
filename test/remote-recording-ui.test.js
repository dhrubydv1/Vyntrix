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
    assert.doesNotMatch(monitorHtml, /Trigger Siren|id="control-siren"/);
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
    assert.doesNotMatch(monitorScript, /control-siren|emit\('trigger-siren'/);
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

  it('wires every Web Monitor control to real monitor or camera behavior', () => {
    assert.match(monitorHtml, /data-remote-quality="360p"/);
    assert.match(monitorHtml, /data-remote-quality="480p"/);
    assert.match(monitorHtml, /data-remote-quality="720p"/);
    assert.match(monitorHtml, /data-remote-quality="1080p"/);
    assert.match(monitorHtml, /id="remote-stream-resolution"/);
    assert.match(monitorHtml, /id="remote-quality-status"/);
    assert.match(monitorHtml, /id="talk-status"/);
    assert.match(monitorScript, /requestRemoteQualityChange/);
    assert.match(monitorScript, /emit\('camera:quality:set'/);
    assert.match(monitorScript, /requestRemoteCameraSwitch/);
    assert.match(monitorScript, /applyRemoteMirror/);
    assert.match(monitorScript, /cycleRemoteVideoRotation/);
    assert.match(monitorScript, /--video-zoom/);
    assert.match(monitorScript, /night-vision-mode/);
    assert.match(monitorScript, /micTrack\.enabled = true/);
    assert.match(cameraScript, /on\('camera:quality:set'/);
    assert.match(cameraScript, /track\?\.getSettings/);
    assert.doesNotMatch(monitorScript, /new RTCPeerConnection[\s\S]*requestRemoteQualityChange/);
  });
});
