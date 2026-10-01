const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const projectRoot = path.join(__dirname, '..');
const monitorHtml = fs.readFileSync(path.join(projectRoot, 'public', 'monitor.html'), 'utf8');
const monitorScript = fs.readFileSync(path.join(projectRoot, 'public', 'js', 'monitor.js'), 'utf8');
const cameraScript = fs.readFileSync(path.join(projectRoot, 'public', 'js', 'camera.js'), 'utf8');

// Browser/media boundaries are doubled; the production control handlers run unchanged.
function controlRuntime(script = monitorScript) {
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) {
      const classes = new Set();
      elements.set(id, { style: { setProperty(name, value) { this[name] = value; }, removeProperty(name) { delete this[name]; } }, dataset: {},
        textContent: '', listeners: {}, disabled: false,
        classList: { add: (...names) => names.forEach(n => classes.add(n)),
          remove: (...names) => names.forEach(n => classes.delete(n)),
          contains: n => classes.has(n), toggle(n, on) { on ? classes.add(n) : classes.delete(n); } },
        setAttribute(name, value) { this[name] = value; },
        append() {}, appendChild() {},
        addEventListener(name, handler) { this.listeners[name] = handler; } });
    }
    return elements.get(id);
  };
  const document = { getElementById: element, querySelector: element,
    querySelectorAll: () => [], createElement: () => element(Symbol()),
    addEventListener() {}, documentElement: element('root') };
  const window = { listeners: {}, addEventListener(name, handler) { this.listeners[name] = handler; } };
  const context = vm.createContext({ document, window, screen: {}, requestAnimationFrame: () => 1,
    cancelAnimationFrame() {},
    console, setInterval: () => 1, clearInterval() {}, clearTimeout() {},
    localStorage: { getItem: () => null, setItem() {} },
    VyntrixRecordingQuality: require('../public/js/recording-quality.js') });
  vm.runInContext(script, context);
  return { context, element, run: code => vm.runInContext(code, context) };
}

describe('monitor control state regressions', () => {
  it('mutes Talk immediately when the live peer is lost', () => {
    const r = controlRuntime();
    r.element('remote-video').srcObject = {};
    r.element('btn-ptt').classList.add('active');
    r.run("socket = {connected:true}; activeCameraSocketId='camera'; micTrack={readyState:'live',enabled:true}; peerConnection={connectionState:'disconnected'}; updateMonitorControlAvailability()");
    assert.equal(r.run('micTrack.enabled'), false);
    assert.equal(r.element('btn-ptt').classList.contains('active'), false);
    assert.equal(r.element('btn-ptt').disabled, true);
  });

  it('requires microphone permission even with a connected live peer', () => {
    const r = controlRuntime();
    r.element('remote-video').srcObject = {};
    r.run("socket={connected:true}; activeCameraSocketId='camera'; peerConnection={connectionState:'connected'}; micTrack=null; updateMonitorControlAvailability()");
    assert.equal(r.element('btn-ptt').disabled, true);
    assert.match(r.element('talk-status').textContent, /Microphone access/);
  });

  for (const state of ['recording', 'uploading']) {
    it(`disables camera and quality commands while ${state}`, () => {
      const r = controlRuntime();
      const facing = r.element('front');
      const quality = r.element('1080p');
      r.context.document.querySelectorAll = selector => selector === '[data-facing-mode]' ? [facing] : [quality];
      r.run(`socket={connected:true}; activeCameraSocketId='camera'; remoteRecordingState='${state}'; updateMonitorControlAvailability()`);
      assert.equal(facing.disabled, true);
      assert.equal(quality.disabled, true);
    });
  }

  it('does not clear the switch lock when camera state is refreshed', () => {
    const r = controlRuntime();
    r.run("remoteCameraSwitchInProgress=true; updateRemoteFacingControls('user')");
    assert.equal(r.run('remoteCameraSwitchInProgress'), true);
  });

  it('never displays the previous camera resolution when settings are missing', () => {
    const r = controlRuntime();
    r.run("updateRemoteRecordingQuality('1080p',1920,1080); updateRemoteRecordingQuality('720p',null,null)");
    assert.equal(r.element('remote-stream-resolution').textContent, 'Resolution unavailable');
  });

  it('disconnects a removed selected camera even when other cameras remain', () => {
    const r = controlRuntime();
    r.run("activeCameraSocketId='gone'; activeCameraName='Gone'; cleanupPeerConnection=()=>{peerConnection=null;}; initiateStreaming=()=>{}; renderCameraSelectionGrid([{socketId:'other',cameraName:'Other'}])");
    assert.equal(r.run('activeCameraSocketId'), null);
    assert.equal(r.element('monitor-portal-view').style.display, 'none');
  });

  it('serializes recording starts before the asynchronous storage check', async () => {
    const r = controlRuntime();
    r.run("socket={connected:true,timeout(){return this;},emit(){sent++;}}; activeCameraSocketId='camera'; var sent=0; var release; refreshRemoteRecordingStorageState=()=>new Promise(resolve=>{release=resolve;});");
    const first = r.run("requestRemoteRecordingControl('start')");
    const second = r.run("requestRemoteRecordingControl('start')");
    assert.equal(r.run('remoteRecordingCommandInProgress'), true);
    r.run('release()');
    await Promise.all([first, second]);
    assert.equal(r.run('sent'), 1);
  });

  it('does not apply a late quality acknowledgement to a different camera', () => {
    const r = controlRuntime();
    r.run("socket={connected:true,timeout(){return this;},emit(event,payload,cb){reply=cb;}}; var reply; activeCameraSocketId='first'; requestRemoteQualityChange('1080p'); activeCameraSocketId='second'; updateRemoteRecordingQuality('360p',640,360); reply(null,{success:true,quality:'1080p',width:1920,height:1080});");
    assert.equal(r.element('remote-stream-resolution').textContent, '640 × 360');
  });

  it('ignores recording state replies for a previously selected camera', () => {
    const r = controlRuntime();
    r.run("socket={connected:true,timeout(){return this;},emit(event,payload,cb){reply=cb;}}; var reply; activeCameraSocketId='first'; requestRemoteRecordingState(); activeCameraSocketId='second'; reply(null,{success:true,state:'recording'});");
    assert.equal(r.run('remoteRecordingState'), 'idle');
  });

  it('does not claim a requested lens is active without a confirmed facing mode', () => {
    const r = controlRuntime();
    r.run("socket={connected:true,timeout(){return this;},emit(event,payload,cb){reply=cb;}}; var reply; activeCameraSocketId='camera'; remoteFacingMode='environment'; requestRemoteCameraSwitch('user'); reply(null,{success:true});");
    assert.equal(r.run('remoteFacingMode'), 'environment');
    assert.equal(r.element('remote-camera-switch-status').classList.contains('is-error'), true);
  });

  it('blocks a camera switch during uploading and quality application', async () => {
    const r = controlRuntime(cameraScript);
    r.run("isStreaming=true; localStream={}; activeFacingMode='user'; recordingPhase='uploading'");
    assert.equal((await r.run("switchCamera('user')")).success, false);
    r.run("recordingPhase='idle'; qualityChangeInProgress=true");
    assert.equal((await r.run("switchCamera('user')")).success, false);
  });

  it('rechecks camera recording state after the storage request completes', async () => {
    const r = controlRuntime(cameraScript);
    r.run("isStreaming=true; localStream={}; var release; refreshRecordingStorageState=()=>new Promise(resolve=>{release=resolve;});");
    const pending = r.run('startRecording()');
    r.run("recordingPhase='recording'; release()");
    assert.equal((await pending).success, false);
    assert.equal(r.run('mediaRecorder'), null);
  });

  it('disables recording Start during a track change', () => {
    const r = controlRuntime();
    r.run("socket={connected:true}; activeCameraSocketId='camera'; remoteQualityChangeInProgress=true; updateMonitorControlAvailability()");
    assert.equal(r.element('btn-start-remote-recording').disabled, true);
  });

  for (const [quality, width, height] of [['360p',640,360], ['480p',854,480], ['720p',1280,720], ['1080p',1920,1080]]) {
    it(`applies ${quality} to the existing video track and reports getSettings dimensions`, async () => {
      const r = controlRuntime(cameraScript);
      r.run("var constraints; var track={getSettings:()=>({width:960,height:540}),getCapabilities:()=>({}),async applyConstraints(value){constraints=value;}}; localStream={getVideoTracks:()=>[track]}; var peer={}; peerConnections.monitor=peer;");
      const response = await r.run(`selectRecordingQuality('${quality}')`);
      assert.equal(r.run('constraints.width.exact'), width);
      assert.equal(r.run('constraints.height.exact'), height);
      assert.equal(response.width, 960);
      assert.equal(response.height, 540);
      assert.equal(r.run('peerConnections.monitor===peer && localStream.getVideoTracks()[0]===track'), true);
    });
  }

  it('preserves the live track and a visible error if all quality constraints fail', async () => {
    const r = controlRuntime(cameraScript);
    r.run("var track={getSettings:()=>({width:1280,height:720}),getCapabilities:()=>({}),async applyConstraints(){throw new Error('unsupported');}}; localStream={getVideoTracks:()=>[track]};");
    const response = await r.run("selectRecordingQuality('1080p')");
    assert.equal(response.success, false);
    assert.equal(response.width, 1280);
    assert.equal(r.element('recording-quality-status').classList.contains('is-error'), true);
    assert.match(r.element('recording-quality-status').textContent, /could not apply/);
    assert.equal(r.run('localStream.getVideoTracks()[0]===track'), true);
  });

  it('drives viewing transforms and hold-to-talk through their DOM handlers', () => {
    const r = controlRuntime();
    r.run('setupDOMListeners()');
    const event = { preventDefault() {}, target: { checked: true, value: '2.5' } };
    r.element('toggle-mirror-view').listeners.change(event);
    r.element('control-zoom').listeners.input(event);
    r.element('control-nightvision').listeners.change(event);
    assert.equal(r.element('remote-video').classList.contains('video-mirrored'), true);
    assert.equal(r.element('remote-video').style['--video-zoom'], 2.5);
    assert.equal(r.element('remote-video').classList.contains('night-vision-mode'), true);
    r.element('remote-video').srcObject = {};
    r.run("socket={connected:true}; activeCameraSocketId='camera'; peerConnection={connectionState:'connected'}; micTrack={readyState:'live',enabled:false}; updateMonitorControlAvailability()");
    r.element('btn-ptt').listeners.pointerdown(event);
    assert.equal(r.run('micTrack.enabled'), true);
    r.context.window.listeners.blur(event);
    assert.equal(r.run('micTrack.enabled'), false);
  });

  it('lays out portrait decoded video without rotating the presentation', () => {
    const r = controlRuntime();
    const video = r.element('remote-video');
    video.videoWidth = 720;
    video.videoHeight = 1280;
    r.run('updateRemoteVideoLayout()');
    assert.equal(r.element('remote-video-stage').dataset.videoOrientation, 'portrait');
    assert.equal(r.element('remote-video-stage').style['--remote-video-aspect-ratio'], '720 / 1280');
    assert.equal(r.element('remote-video-stage').dataset.videoRotation, undefined);
  });

  it('lays out landscape decoded video without rotating the presentation', () => {
    const r = controlRuntime();
    const video = r.element('remote-video');
    video.videoWidth = 1280;
    video.videoHeight = 720;
    r.run('updateRemoteVideoLayout()');
    assert.equal(r.element('remote-video-stage').dataset.videoOrientation, 'landscape');
    assert.equal(r.element('remote-video-stage').style['--remote-video-aspect-ratio'], '1280 / 720');
    assert.equal(r.element('remote-video-stage').dataset.videoRotation, undefined);
  });

  it('uses the authenticated source orientation only until decoded dimensions arrive', () => {
    const r = controlRuntime();
    r.run("updateRemoteCameraOrientation({orientation:'portrait'})");
    assert.equal(r.element('remote-video-stage').dataset.videoOrientation, 'portrait');
    r.element('remote-video').videoWidth = 1280;
    r.element('remote-video').videoHeight = 720;
    r.run('updateRemoteVideoLayout()');
    assert.equal(r.element('remote-video-stage').dataset.videoOrientation, 'landscape');
  });

  it('keeps the safe default stage when both decoded and source orientation are unavailable', () => {
    const r = controlRuntime();
    r.run('updateRemoteCameraOrientation({orientation:"invalid"}); updateRemoteVideoLayout()');
    assert.equal(r.element('remote-video-stage').dataset.videoOrientation, undefined);
    assert.equal(r.run('peerConnection'), null);
  });

  it('updates orientation in-place while the same peer remains connected', () => {
    const r = controlRuntime();
    const video = r.element('remote-video');
    video.videoWidth = 1280;
    video.videoHeight = 720;
    r.run("var livePeer={connectionState:'connected'}; peerConnection=livePeer; updateRemoteVideoLayout()");
    video.videoWidth = 720;
    video.videoHeight = 1280;
    r.run('updateRemoteVideoLayout()');
    assert.equal(r.element('remote-video-stage').dataset.videoOrientation, 'portrait');
    assert.equal(r.run('peerConnection===livePeer'), true);
  });

  it('keeps mirror, zoom, and fullscreen independent of automatic orientation', async () => {
    const r = controlRuntime();
    const video = r.element('remote-video');
    video.videoWidth = 720;
    video.videoHeight = 1280;
    r.run("applyRemoteMirror(true); document.getElementById('remote-video').style.setProperty('--video-zoom', 2); updateRemoteVideoLayout()");
    const stage = r.element('remote-video-stage');
    stage.requestFullscreen = async () => { r.context.document.fullscreenElement = stage; };
    await r.run('toggleMonitorFullscreen()');
    assert.equal(video.classList.contains('video-mirrored'), true);
    assert.equal(video.style['--video-zoom'], 2);
    assert.equal(r.run('monitorIsFullscreen()'), true);
    assert.equal(stage.dataset.videoOrientation, 'portrait');
  });

  it('publishes Android screen orientation through the authenticated camera state', () => {
    const r = controlRuntime(cameraScript);
    r.context.screen.orientation = { type: 'portrait-primary' };
    r.run("var sent=[]; socket={connected:true,emit(name,payload){sent.push({name,payload});}}; localStream={getVideoTracks:()=>[{getSettings:()=>({width:1280,height:720})}]}; publishCameraOrientation(true)");
    assert.equal(r.run("sent.find(event => event.name === 'camera:orientation').payload.orientation"), 'portrait');
  });

  it('uses iOS viewport orientation when the Screen Orientation API is unavailable', () => {
    const r = controlRuntime(cameraScript);
    r.context.window.matchMedia = () => ({ matches: true });
    r.run("var sent=[]; socket={connected:true,emit(name,payload){sent.push({name,payload});}}; localStream={getVideoTracks:()=>[{getSettings:()=>({width:1280,height:720})}]}; publishCameraOrientation(true)");
    assert.equal(r.run("sent.find(event => event.name === 'camera:orientation').payload.orientation"), 'portrait');
  });

  it('requests real fullscreen and disables it when the browser lacks support', async () => {
    const r = controlRuntime();
    r.element('remote-video').srcObject = {};
    r.run("socket={connected:true}; activeCameraSocketId='camera'; updateMonitorControlAvailability()");
    assert.equal(r.element('btn-toggle-fullscreen').disabled, true);
    const stage = r.element('remote-video-stage');
    stage.requestFullscreen = async () => { r.context.document.fullscreenElement = stage; };
    r.run('updateMonitorControlAvailability()');
    assert.equal(r.element('btn-toggle-fullscreen').disabled, false);
    await r.run('toggleMonitorFullscreen()');
    assert.equal(r.run('monitorIsFullscreen()'), true);
  });

  for (const [facing, width, height, orientation] of [
    ['user', 720, 1280, 'portrait'],
    ['environment', 1280, 720, 'landscape']
  ]) {
    it(`switches to ${facing} using replaceTrack while retaining the peer and audio`, async () => {
      const r = controlRuntime(cameraScript);
      r.run(`
        var oldTrack={kind:'video',getSettings:()=>({deviceId:'old',facingMode:'${facing === 'user' ? 'environment' : 'user'}'}),
          removeEventListener(){},stop(){this.stopped=true;}};
        var newTrack={kind:'video',label:'${facing === 'user' ? 'Front' : 'Back'}',getSettings:()=>({deviceId:'new',facingMode:'${facing}',width:${width},height:${height}}),addEventListener(){},stop(){}};
        var audio={kind:'audio'};
        var MediaStream=class {constructor(tracks){this.tracks=tracks;} getTracks(){return this.tracks;}
          getVideoTracks(){return this.tracks.filter(t=>t.kind==='video');} getAudioTracks(){return this.tracks.filter(t=>t.kind==='audio');}};
        var navigator={mediaDevices:{async enumerateDevices(){return [{kind:'videoinput',deviceId:'new',label:newTrack.label}];},
          async getUserMedia(constraints){requestedConstraints=constraints;return new MediaStream([newTrack]);}}};
        var requestedConstraints;
        var sender={track:oldTrack,async replaceTrack(track){this.track=track;}};
        var peer={getSenders:()=>[sender]}; peerConnections.monitor=peer;
        localStream=new MediaStream([oldTrack,audio]); isStreaming=true;
        var orientationEvents=[]; socket={connected:true,emit(name,payload){if(name==='camera:orientation')orientationEvents.push(payload);}};
        activeFacingMode='${facing === 'user' ? 'environment' : 'user'}';
        supportedRecordingMimeType=()=>'';
        updateCameraDiagnostics=()=>{};
      `);
      const response = await r.run(`switchCamera('${facing}')`);
      assert.equal(response.success, true);
      assert.equal(response.facingMode, facing);
      assert.equal(r.run('requestedConstraints.video.deviceId.exact'), 'new');
      assert.equal(r.run('sender.track===newTrack && peerConnections.monitor===peer'), true);
      assert.equal(r.run('localStream.getAudioTracks()[0]===audio'), true);
      assert.equal(r.run('oldTrack.stopped'), true);
      assert.equal(r.run(`orientationEvents.some(event => event.orientation === '${orientation}')`), true);
    });
  }

  for (const [state, startHidden, stopHidden, stopDisabled, label] of [
    ['idle',false,true,true,'Ready to record'],
    ['recording',true,false,false,'Recording in progress'],
    ['uploading',true,false,true,'Stopping and uploading…'],
    ['uploaded',false,true,true,'Recording uploaded']
  ]) {
    it(`renders confirmed ${state} recording state with correct controls`, () => {
      const r = controlRuntime();
      r.run(`socket={connected:true}; activeCameraSocketId='camera'; applyRemoteRecordingState({state:'${state}',startedAt:'2026-09-30T00:00:00Z'})`);
      assert.equal(r.element('btn-start-remote-recording').hidden, startHidden);
      assert.equal(r.element('btn-stop-remote-recording').hidden, stopHidden);
      assert.equal(r.element('btn-stop-remote-recording').disabled, stopDisabled);
      assert.equal(r.element('remote-recording-state').textContent, label);
    });
  }
});

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
    assert.match(monitorScript, /updateRemoteCameraOrientation/);
    assert.match(monitorScript, /--video-zoom/);
    assert.match(monitorScript, /night-vision-mode/);
    assert.match(monitorScript, /micTrack\.enabled = true/);
    assert.match(cameraScript, /on\('camera:quality:set'/);
    assert.match(cameraScript, /track\?\.getSettings/);
    assert.doesNotMatch(monitorScript, /new RTCPeerConnection[\s\S]*requestRemoteQualityChange/);
    assert.doesNotMatch(monitorHtml, /btn-rotate-view|rotation-val|>Rotate/);
    assert.doesNotMatch(monitorScript, /remoteVideoRotation|cycleRemoteVideoRotation|setRemoteVideoRotation|is-remote-rotated/);
    assert.match(cameraScript, /camera:orientation/);
  });
});
