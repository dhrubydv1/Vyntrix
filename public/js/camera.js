// Camera Console Logic - Vyntrix

let socket;
let localStream = null;
let userId = null;
let cameraName = 'Camera';
let isStreaming = false;
let iceServers = null;
let activeFacingMode = 'environment';
let cameraSwitchInProgress = false;
let cameraStartInProgress = false;
let videoInputDevices = [];
let cameraStopInProgress = false;

// Manual recording uses the active stream without replacing or cloning tracks.
let mediaRecorder = null;
let recordingChunks = [];
let recordingStartedAt = null;
let recordingStartedMonotonic = 0;
let recordingTimerId = null;
let recordingPhase = 'idle';
let recordingStopPromise = null;
let resolveRecordingStop = null;
let recordingFinalizedPromise = null;
let resolveRecordingFinalized = null;
let recordingPublicState = 'idle';
let recordingPublicMessage = '';

const deviceFacingHints = new Map();

const CAMERA_FACING_STORAGE_KEY = 'vyntrix.camera.facingMode';
const CAMERA_MIRROR_STORAGE_KEY = 'vyntrix.camera.mirrorPreview';
const VALID_FACING_MODES = new Set(['user', 'environment']);

// WebRTC connections map: monitorSocketId -> RTCPeerConnection
const peerConnections = {};

// Motion Detection Variables
let prevFrameData = null;
let motionIntervalId = null;
let motionDetectionEnabled = false;
let motionEventActive = false;
let motionEventStartedAt = 0;
let lastMotionDetectedAt = 0;
let motionResetTimeoutId = null;
let motionAlertController = null;
const MOTION_EVENT_COOLDOWN_MS = 30000;
const MOTION_RESET_MS = 3000;

// Audio Synth Alarm (Siren)
let audioCtx = null;
let sirenCarrier = null;
let sirenModulator = null;
let sirenGain = null;

// Initialize Session & Auth
async function init() {
  const session = await protectPage();
  if (!session?.loggedIn) return;
  if (session.loggedIn) {
    userId = session.user.id;
    window.CCTV_USER_ID = userId;
    // Suggest default camera name based on browser/OS
    const os = navigator.userAgent.includes('Windows') ? 'PC' : 
               navigator.userAgent.includes('Android') ? 'Android' : 
               navigator.userAgent.includes('iPhone') ? 'iPhone' : 'Device';
    document.getElementById('camera-name').value = `${session.user.username}'s ${os} Camera`;
  }
  
  setupDOMListeners();
  setupTimeCounter();
  updateCameraStatus('connecting');
  showCameraOperationMessage('Connecting securely to Vyntrix…');
  try {
    await window.VyntrixSocketReady;
    updateCameraStatus('offline');
    showCameraOperationMessage();
  } catch (err) {
    console.error('Signaling client could not be loaded:', err);
    updateCameraStatus('failed');
    showCameraOperationMessage('Vyntrix could not be reached. Check your connection and reload.', true);
    return;
  }

  // Auto-start camera if redirect query param is present
  const params = new URLSearchParams(window.location.search);
  if (params.get('autostart') === 'true') {
    setTimeout(() => {
      startCamera();
    }, 500);
  }
}

function setupDOMListeners() {
  document.getElementById('btn-start').addEventListener('click', startCamera);
  document.getElementById('btn-stop').addEventListener('click', stopCamera);
  document.getElementById('btn-start-recording').addEventListener('click', startRecording);
  document.getElementById('btn-stop-recording').addEventListener('click', stopRecording);
  document.getElementById('btn-kill-siren').addEventListener('click', stopSiren);
  
  // Motion settings update
  const sensitivitySlider = document.getElementById('motion-sensitivity');
  const sensitivityValText = document.getElementById('sensitivity-val');
  const motionToggle = document.getElementById('toggle-motion');
  const mirrorToggle = document.getElementById('toggle-mirror-preview');

  activeFacingMode = readFacingPreference();
  updateFacingControls(activeFacingMode);
  mirrorToggle.checked = readBooleanPreference(CAMERA_MIRROR_STORAGE_KEY);
  applyLocalMirror(mirrorToggle.checked);
  updateRecordingControls();

  document.querySelectorAll('[data-facing-mode]').forEach((button) => {
    button.addEventListener('click', async () => {
      const facingMode = button.dataset.facingMode;
      if (!VALID_FACING_MODES.has(facingMode)) return;
      if (!isStreaming) {
        activeFacingMode = facingMode;
        writePreference(CAMERA_FACING_STORAGE_KEY, facingMode);
        updateFacingControls(facingMode);
        showCameraSwitchStatus(`${facingLabel(facingMode)} camera selected for startup.`);
        return;
      }
      await switchCamera(facingMode);
    });
  });

  mirrorToggle.addEventListener('change', (event) => {
    const mirrored = event.target.checked;
    writePreference(CAMERA_MIRROR_STORAGE_KEY, String(mirrored));
    applyLocalMirror(mirrored);
  });

  motionDetectionEnabled = motionToggle.checked;
  motionToggle.addEventListener('change', (e) => {
    motionDetectionEnabled = e.target.checked;
    if (motionDetectionEnabled && isStreaming) {
      startMotionDetection();
    } else if (!motionDetectionEnabled) {
      stopMotionDetection();
    }
  });

  sensitivitySlider.addEventListener('input', (e) => {
    const val = parseInt(e.target.value);
    if (val <= 20) sensitivityValText.innerText = 'High (Very Sensitive)';
    else if (val <= 45) sensitivityValText.innerText = 'Medium';
    else sensitivityValText.innerText = 'Low (Heavy Movement)';
  });
}

function readFacingPreference() {
  try {
    const saved = localStorage.getItem(CAMERA_FACING_STORAGE_KEY);
    return VALID_FACING_MODES.has(saved) ? saved : 'environment';
  } catch (_) {
    return 'environment';
  }
}

function readBooleanPreference(key) {
  try {
    return localStorage.getItem(key) === 'true';
  } catch (_) {
    return false;
  }
}

function writePreference(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch (_) {
    // Camera operation should not depend on storage availability.
  }
}

function facingLabel(facingMode) {
  return facingMode === 'user' ? 'Front' : 'Back';
}

function updateFacingControls(facingMode, disabled = false) {
  document.querySelectorAll('[data-facing-mode]').forEach((button) => {
    button.setAttribute('aria-pressed', String(button.dataset.facingMode === facingMode));
    button.disabled = disabled || recordingIsActive();
  });
}

function showCameraSwitchStatus(message = '', isError = false) {
  const status = document.getElementById('camera-switch-status');
  if (!status) return;
  status.textContent = message;
  status.classList.toggle('is-error', isError);
}

function showCameraOperationMessage(message = '', isError = false) {
  const messageEl = document.getElementById('camera-operation-message');
  if (!messageEl) return;
  messageEl.textContent = message;
  messageEl.hidden = !message;
  messageEl.classList.toggle('is-error', isError);
}

function applyLocalMirror(mirrored) {
  document.getElementById('webcam-preview')?.classList.toggle('video-mirrored', mirrored);
}

function cameraLabelMatchesFacing(label, facingMode) {
  const normalized = label.toLowerCase();
  const frontPattern = /\b(front|user|selfie|facetime|frontal|face)\b|前置|前面|전면/;
  const backPattern = /\b(back|rear|environment|world|backside|traseira|trasera)\b|后置|後置|背面|후면/;
  return (facingMode === 'user' ? frontPattern : backPattern).test(normalized);
}

function inferFacingFromLabel(label) {
  if (cameraLabelMatchesFacing(label || '', 'user')) return 'user';
  if (cameraLabelMatchesFacing(label || '', 'environment')) return 'environment';
  return null;
}

function rememberTrackFacing(track, facingMode) {
  const settings = track?.getSettings?.() || {};
  const reportedFacing = getTrackFacingMode(track) || inferFacingFromLabel(track?.label);
  const knownFacing = reportedFacing || (VALID_FACING_MODES.has(facingMode) ? facingMode : null);
  if (settings.deviceId && knownFacing) deviceFacingHints.set(settings.deviceId, knownFacing);
}

async function refreshVideoInputDevices() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    videoInputDevices = devices.filter((device) => device.kind === 'videoinput');
  } catch (error) {
    videoInputDevices = [];
    console.warn('Could not enumerate video inputs:', error?.name || 'Error', error?.message || 'Unknown error');
  }
  updateCameraDiagnostics(localStream?.getVideoTracks()[0]);
  return videoInputDevices;
}

function updateCameraDiagnostics(track) {
  const count = document.getElementById('diagnostic-camera-count');
  const selected = document.getElementById('diagnostic-selected-camera');
  if (count) count.textContent = String(videoInputDevices.length);
  if (!selected) return;
  if (!track) {
    selected.textContent = 'No active camera';
    return;
  }

  const settings = track.getSettings?.() || {};
  const deviceIndex = videoInputDevices.findIndex((device) => device.deviceId === settings.deviceId);
  const ordinal = deviceIndex >= 0 ? `Camera ${deviceIndex + 1} of ${videoInputDevices.length}` : 'Active camera';
  const facing = getTrackFacingMode(track) || inferFacingFromLabel(track.label) || activeFacingMode;
  selected.textContent = `${track.label || ordinal}${facing ? ` (${facingLabel(facing)})` : ''}`;
  console.info('[Vyntrix] Camera selection:', {
    detectedVideoInputs: videoInputDevices.length,
    selectedLabel: track.label || ordinal,
    selectedDeviceIndex: deviceIndex >= 0 ? deviceIndex + 1 : null,
    facingMode: facing || null,
    width: settings.width || null,
    height: settings.height || null
  });
}

function selectCameraDevice(facingMode, currentTrack) {
  const currentDeviceId = currentTrack?.getSettings?.().deviceId || null;
  const currentFacing = getTrackFacingMode(currentTrack) || activeFacingMode;

  if (currentDeviceId && currentFacing === facingMode) {
    return videoInputDevices.find((device) => device.deviceId === currentDeviceId) || null;
  }

  const hinted = videoInputDevices.find((device) => deviceFacingHints.get(device.deviceId) === facingMode);
  if (hinted) return hinted;

  const labelMatch = videoInputDevices.find((device) => cameraLabelMatchesFacing(device.label || '', facingMode));
  if (labelMatch) return labelMatch;

  if (currentDeviceId && videoInputDevices.length === 2) {
    return videoInputDevices.find((device) => device.deviceId !== currentDeviceId) || null;
  }

  return null;
}

function setupTimeCounter() {
  setInterval(() => {
    const now = new Date();
    const timeStr = now.toISOString().replace('T', ' ').substring(0, 19);
    const el = document.getElementById('stream-time');
    if (el) el.innerText = timeStr;
  }, 1000);
}

function recordingIsActive() {
  return Boolean(mediaRecorder && mediaRecorder.state !== 'inactive');
}

function recordingStateSnapshot(message = recordingPublicMessage) {
  return {
    state: recordingPublicState,
    startedAt: recordingStartedAt?.toISOString() || null,
    message
  };
}

function publishRecordingState(state, message = '') {
  recordingPublicState = state;
  recordingPublicMessage = message;
  const snapshot = recordingStateSnapshot();
  if (socket?.connected) socket.emit('recording:state', snapshot);
  return snapshot;
}

function supportedRecordingMimeType() {
  if (!window.MediaRecorder || typeof MediaRecorder.isTypeSupported !== 'function') return null;
  const candidates = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
    'video/mp4'
  ];
  return candidates.find(type => MediaRecorder.isTypeSupported(type)) || null;
}

function formatRecordingElapsed(totalSeconds) {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const base = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  return hours ? `${String(hours).padStart(2, '0')}:${base}` : base;
}

function updateRecordingTimer() {
  const elapsed = document.getElementById('recording-elapsed');
  if (!elapsed || !recordingStartedMonotonic) return;
  const totalSeconds = Math.max(0, Math.floor((performance.now() - recordingStartedMonotonic) / 1000));
  elapsed.textContent = formatRecordingElapsed(totalSeconds);
  elapsed.dateTime = `PT${totalSeconds}S`;
}

function stopRecordingTimer() {
  if (recordingTimerId) {
    clearInterval(recordingTimerId);
    recordingTimerId = null;
  }
}

function updateRecordingControls(message = '', isError = false) {
  const card = document.querySelector('.recording-card');
  const state = document.getElementById('recording-state');
  const feedback = document.getElementById('recording-feedback');
  const startButton = document.getElementById('btn-start-recording');
  const stopButton = document.getElementById('btn-stop-recording');
  if (!card || !state || !feedback || !startButton || !stopButton) return;

  const recordingSupported = Boolean(supportedRecordingMimeType());
  card.classList.toggle('is-recording', recordingPhase === 'recording');
  card.classList.toggle('is-uploading', recordingPhase === 'uploading');
  startButton.hidden = recordingPhase !== 'idle';
  stopButton.hidden = recordingPhase === 'idle';
  startButton.disabled = !isStreaming || !recordingSupported || cameraSwitchInProgress || cameraStopInProgress;
  stopButton.disabled = recordingPhase !== 'recording';
  stopButton.textContent = recordingPhase === 'recording' ? 'Stop Recording' : 'Saving…';
  state.textContent = recordingPhase === 'recording'
    ? 'Recording in progress'
    : recordingPhase === 'uploading'
      ? 'Uploading securely…'
      : !recordingSupported
        ? 'Recording is unavailable in this browser'
        : isStreaming
          ? 'Ready to record'
          : 'Start the camera to record';
  feedback.textContent = message;
  feedback.classList.toggle('is-error', isError);
}

async function startRecording() {
  if (!isStreaming || !localStream) {
    return { success: false, ...recordingStateSnapshot('Start the camera before recording.') };
  }
  if (recordingPhase !== 'idle' || cameraSwitchInProgress) {
    return { success: false, ...recordingStateSnapshot(
      recordingPhase === 'recording' ? 'Recording is already active.' : 'The camera is busy. Try again shortly.'
    ) };
  }
  const mimeType = supportedRecordingMimeType();
  if (!mimeType) {
    updateRecordingControls('This browser does not support WebM or MP4 recording.', true);
    return { success: false, ...publishRecordingState('error', 'Recording is unavailable on this device.') };
  }

  try {
    recordingChunks = [];
    recordingStartedAt = new Date();
    recordingStartedMonotonic = performance.now();
    const recorder = new MediaRecorder(localStream, { mimeType });
    mediaRecorder = recorder;
    recordingStopPromise = new Promise(resolve => { resolveRecordingStop = resolve; });
    recordingFinalizedPromise = new Promise(resolve => { resolveRecordingFinalized = resolve; });

    recorder.addEventListener('dataavailable', (event) => {
      if (event.data?.size) recordingChunks.push(event.data);
    });
    recorder.addEventListener('error', () => {
      updateRecordingControls('Recording stopped because the browser reported a media error.', true);
      if (recorder.state !== 'inactive') recorder.stop();
    });
    recorder.addEventListener('stop', () => {
      void finalizeRecording(recorder, mimeType);
    }, { once: true });

    recorder.start(1000);
    recordingPhase = 'recording';
    updateRecordingTimer();
    recordingTimerId = setInterval(updateRecordingTimer, 1000);
    updateFacingControls(activeFacingMode);
    updateRecordingControls();
    return { success: true, ...publishRecordingState('recording') };
  } catch (error) {
    console.error('Could not start manual recording:', error?.name || 'Error');
    mediaRecorder = null;
    recordingChunks = [];
    recordingStartedAt = null;
    recordingStartedMonotonic = 0;
    recordingStopPromise = null;
    resolveRecordingStop = null;
    recordingFinalizedPromise = null;
    resolveRecordingFinalized = null;
    updateRecordingControls('Recording could not start on this device.', true);
    return { success: false, ...publishRecordingState('error', 'Recording could not start on this device.') };
  }
}

function stopRecording() {
  if (!mediaRecorder) return recordingStopPromise || Promise.resolve();
  if (mediaRecorder.state !== 'inactive') {
    recordingPhase = 'uploading';
    stopRecordingTimer();
    updateRecordingControls();
    publishRecordingState('uploading', 'Saving recording securely…');
    mediaRecorder.stop();
  }
  return recordingStopPromise || Promise.resolve();
}

async function finalizeRecording(recorder, selectedMimeType) {
  const endedAt = new Date();
  const durationSeconds = Math.max(
    0,
    Math.round((performance.now() - recordingStartedMonotonic) / 1000)
  );
  const contentType = recorder.mimeType || selectedMimeType;
  const blob = new Blob(recordingChunks, { type: contentType });
  resolveRecordingFinalized?.();
  resolveRecordingFinalized = null;
  recordingPhase = 'uploading';
  stopRecordingTimer();
  updateRecordingControls();

  try {
    if (!blob.size) throw new Error('The browser produced an empty recording.');
    const normalizedType = contentType.split(';', 1)[0].toLowerCase();
    const extension = normalizedType === 'video/mp4' ? 'mp4' : 'webm';
    const formData = new FormData();
    formData.append('recording', blob, `recording.${extension}`);
    formData.append('cameraName', cameraName);
    formData.append('startedAt', recordingStartedAt.toISOString());
    formData.append('endedAt', endedAt.toISOString());
    formData.append('durationSeconds', String(durationSeconds));

    const response = await fetch(VyntrixConfig.apiUrl('/api/recordings'), {
      method: 'POST',
      credentials: 'include',
      body: formData
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.success) {
      throw new Error(result.error || 'Recording upload failed.');
    }
    updateRecordingControls('Recording saved securely.');
    publishRecordingState('uploaded', 'Recording saved securely.');
  } catch (error) {
    console.error('Could not save manual recording:', error?.name || 'Error');
    updateRecordingControls(
      error?.message === 'Recording is larger than the upload limit.'
        ? error.message
        : 'Recording could not be saved. Check your connection and try a shorter clip.',
      true
    );
    publishRecordingState('error', 'Recording could not be saved.');
  } finally {
    mediaRecorder = null;
    recordingChunks = [];
    recordingStartedAt = null;
    recordingStartedMonotonic = 0;
    recordingPhase = 'idle';
    const finish = resolveRecordingStop;
    resolveRecordingStop = null;
    recordingStopPromise = null;
    recordingFinalizedPromise = null;
    updateFacingControls(activeFacingMode, cameraSwitchInProgress);
    updateRecordingControls(
      document.getElementById('recording-feedback')?.textContent || '',
      document.getElementById('recording-feedback')?.classList.contains('is-error') || false
    );
    finish?.();
  }
}

// Siren sound synthesis using Web Audio API
function startSiren() {
  if (audioCtx) return; // Already running

  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    
    // Create Nodes
    sirenCarrier = audioCtx.createOscillator();
    sirenModulator = audioCtx.createOscillator();
    const modGain = audioCtx.createGain();
    sirenGain = audioCtx.createGain();
    
    // Configure Carrier (the main sound)
    sirenCarrier.type = 'sawtooth';
    sirenCarrier.frequency.value = 750; // Central frequency
    
    // Configure Modulator (LFO that sweeps the pitch up and down)
    sirenModulator.type = 'sine';
    sirenModulator.frequency.value = 2; // Sweep frequency (2 Hz)
    
    // Modulation depth (amplitude of the sweep: +- 300Hz)
    modGain.gain.value = 300; 
    
    // Volume Gain
    sirenGain.gain.setValueAtTime(0.0, audioCtx.currentTime);
    sirenGain.gain.linearRampToValueAtTime(0.7, audioCtx.currentTime + 0.1); // Fade in
    
    // Connections
    // Modulator -> modGain -> Carrier Frequency (Modulation)
    sirenModulator.connect(modGain);
    modGain.connect(sirenCarrier.frequency);
    
    // Carrier -> Volume -> Speakers
    sirenCarrier.connect(sirenGain);
    sirenGain.connect(audioCtx.destination);
    
    // Start oscillators
    sirenCarrier.start();
    sirenModulator.start();

    // UI Updates
    document.getElementById('local-siren-card').style.background = 'rgba(255, 59, 48, 0.15)';
    document.getElementById('btn-kill-siren').style.display = 'block';
    updateCameraStatus('alerting');
  } catch (err) {
    console.error('Failed to start Web Audio Siren:', err);
  }
}

function stopSiren() {
  if (!audioCtx) return;

  try {
    sirenGain.gain.setValueAtTime(sirenGain.gain.value, audioCtx.currentTime);
    sirenGain.gain.linearRampToValueAtTime(0.0, audioCtx.currentTime + 0.1); // Fade out
    
    const tempCtx = audioCtx;
    const tempCarrier = sirenCarrier;
    const tempModulator = sirenModulator;
    
    audioCtx = null;
    sirenCarrier = null;
    sirenModulator = null;
    sirenGain = null;

    setTimeout(() => {
      tempCarrier.stop();
      tempModulator.stop();
      tempCtx.close();
    }, 150);

    // UI Updates
    document.getElementById('local-siren-card').style.background = 'rgba(255, 59, 48, 0.02)';
    document.getElementById('btn-kill-siren').style.display = 'none';
    if (isStreaming) {
      updateCameraStatus('streaming');
    }
  } catch (err) {
    console.error('Failed to stop Web Audio Siren:', err);
  }
}

// Media stream functions
async function startCamera() {
  if (cameraStartInProgress || isStreaming) return;
  cameraStartInProgress = true;
  const startButton = document.getElementById('btn-start');
  startButton.disabled = true;
  startButton.textContent = 'Starting…';
  updateCameraStatus('permission');
  showCameraOperationMessage('Allow camera and microphone access to start streaming.');
  cameraName = document.getElementById('camera-name').value.trim() || 'Camera';
  const preferredFacingMode = readFacingPreference();
  
  try {
    try {
      localStream = await navigator.mediaDevices.getUserMedia({
        video: cameraVideoConstraints(preferredFacingMode, true),
        audio: true
      });
      activeFacingMode = preferredFacingMode;
    } catch (preferredError) {
      if (!['OverconstrainedError', 'NotFoundError', 'DevicesNotFoundError'].includes(preferredError.name)) {
        throw preferredError;
      }
      console.warn(`Preferred ${preferredFacingMode} camera unavailable; using the available camera.`, preferredError);
      localStream = await navigator.mediaDevices.getUserMedia({
        video: cameraVideoConstraints(),
        audio: true
      });
      activeFacingMode = getTrackFacingMode(localStream.getVideoTracks()[0]);
      showCameraSwitchStatus(`${facingLabel(preferredFacingMode)} camera was unavailable. Using the available camera.`, true);
    }

    attachTrackEndListeners(localStream);
    updateFacingControls(activeFacingMode);
    
    const previewEl = document.getElementById('webcam-preview');
    previewEl.srcObject = localStream;
    const activeVideoTrack = localStream.getVideoTracks()[0];
    const detectedFacing = getTrackFacingMode(activeVideoTrack) || inferFacingFromLabel(activeVideoTrack?.label);
    if (detectedFacing) activeFacingMode = detectedFacing;
    rememberTrackFacing(activeVideoTrack, activeFacingMode);
    await refreshVideoInputDevices();
    
    // Set UI state
    document.getElementById('btn-start').style.display = 'none';
    document.getElementById('btn-stop').style.display = 'block';
    document.getElementById('camera-name').disabled = true;
    document.getElementById('rec-indicator').style.display = 'flex';
    
    isStreaming = true;
    updateCameraStatus('streaming');
    showCameraOperationMessage();
    updateRecordingControls();

    iceServers = await getIceServers();
    if (!isStreaming) return;

    // Establish Socket.io connection
    connectSocket();
    
    // Start Motion Detection loop
    startMotionDetection();
  } catch (err) {
    console.error('getUserMedia error:', err);
    const denied = ['NotAllowedError', 'PermissionDeniedError'].includes(err?.name);
    const missing = ['NotFoundError', 'DevicesNotFoundError'].includes(err?.name);
    const message = denied
      ? 'Camera access was not allowed. Enable camera and microphone permissions, then try again.'
      : missing
        ? 'No usable camera was found on this device.'
        : 'The camera could not be started. Close other camera apps and try again.';
    updateCameraStatus('failed');
    showCameraOperationMessage(message, true);
  } finally {
    cameraStartInProgress = false;
    startButton.disabled = false;
    startButton.textContent = 'Start Camera';
  }
}

function cameraVideoConstraints(facingMode, requireFacingMode = false) {
  return {
    width: { ideal: 1280 },
    height: { ideal: 720 },
    ...(VALID_FACING_MODES.has(facingMode) && {
      facingMode: requireFacingMode ? { exact: facingMode } : { ideal: facingMode }
    })
  };
}

function cameraDeviceConstraints(deviceId) {
  return {
    width: { ideal: 1280 },
    height: { ideal: 720 },
    deviceId: { exact: deviceId }
  };
}

function getTrackFacingMode(track) {
  const facingMode = track?.getSettings?.().facingMode;
  return VALID_FACING_MODES.has(facingMode) ? facingMode : null;
}

function attachTrackEndListeners(stream) {
  stream.getTracks().forEach((track) => track.addEventListener('ended', handleLocalStreamEnded));
}

function detachTrackEndListener(track) {
  track?.removeEventListener('ended', handleLocalStreamEnded);
}

async function acquireVideoTrack(videoConstraints) {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: videoConstraints,
    audio: false
  });
  const track = stream.getVideoTracks()[0];
  if (!track) {
    stream.getTracks().forEach((streamTrack) => streamTrack.stop());
    throw new Error('The selected camera did not provide a video track.');
  }
  stream.getTracks().forEach((streamTrack) => {
    if (streamTrack !== track) streamTrack.stop();
  });
  return track;
}

async function acquireRequestedCamera(device, facingMode, previousDeviceId) {
  let lastError = null;

  if (device?.deviceId) {
    try {
      return await acquireVideoTrack(cameraDeviceConstraints(device.deviceId));
    } catch (error) {
      lastError = error;
    }
  }

  // If labels did not identify the lens, inspect each other enumerated device
  // by exact deviceId and keep only a track that reports the desired facing.
  const candidates = videoInputDevices.filter((candidate) => (
    candidate.deviceId
    && candidate.deviceId !== previousDeviceId
    && candidate.deviceId !== device?.deviceId
  ));
  for (const candidate of candidates) {
    let candidateTrack = null;
    try {
      candidateTrack = await acquireVideoTrack(cameraDeviceConstraints(candidate.deviceId));
      const detectedFacing = getTrackFacingMode(candidateTrack)
        || inferFacingFromLabel(candidateTrack.label)
        || deviceFacingHints.get(candidate.deviceId);
      if (detectedFacing === facingMode) return candidateTrack;
    } catch (error) {
      lastError = error;
    }
    candidateTrack?.stop();
  }

  try {
    return await acquireVideoTrack(cameraVideoConstraints(facingMode, true));
  } catch (error) {
    lastError = error;
  }
  throw lastError || new Error('The requested camera is unavailable.');
}

async function restorePreviousCamera(deviceId, facingMode) {
  const attempts = [
    ...(deviceId ? [cameraDeviceConstraints(deviceId)] : []),
    ...(VALID_FACING_MODES.has(facingMode) ? [cameraVideoConstraints(facingMode, true)] : []),
    cameraVideoConstraints()
  ];
  for (const constraints of attempts) {
    try {
      return await acquireVideoTrack(constraints);
    } catch (_) {
      // Try the next, less-specific restoration constraint.
    }
  }
  return null;
}

function installActiveVideoTrack(track, audioTracks, facingMode) {
  track.addEventListener('ended', handleLocalStreamEnded);
  localStream = new MediaStream([...audioTracks, track]);
  document.getElementById('webcam-preview').srcObject = localStream;
  prevFrameData = null;
  activeFacingMode = getTrackFacingMode(track) || inferFacingFromLabel(track.label) || facingMode;
  rememberTrackFacing(track, activeFacingMode);
  updateCameraDiagnostics(track);
}

async function switchCamera(facingMode) {
  if (!VALID_FACING_MODES.has(facingMode)) {
    return { success: false, message: 'Choose Front or Back camera.' };
  }
  if (!isStreaming || !localStream) {
    return { success: false, message: 'Start the Camera Console before switching cameras.' };
  }
  if (cameraSwitchInProgress) {
    return { success: false, message: 'A camera switch is already in progress.' };
  }
  if (recordingIsActive()) {
    const message = 'Stop the current recording before switching cameras.';
    showCameraSwitchStatus(message, true);
    return { success: false, message };
  }
  if (activeFacingMode === facingMode) {
    updateFacingControls(facingMode);
    return { success: true, facingMode, message: `${facingLabel(facingMode)} camera is already active.` };
  }

  cameraSwitchInProgress = true;
  updateFacingControls(activeFacingMode, true);
  updateRecordingControls();
  showCameraSwitchStatus(`Switching to ${facingLabel(facingMode).toLowerCase()} camera…`);
  updateCameraStatus('switching');

  let newVideoTrack = null;
  const oldVideoTrack = localStream.getVideoTracks()[0];
  const audioTracks = localStream.getAudioTracks();
  const oldSettings = oldVideoTrack?.getSettings?.() || {};
  const previousFacingMode = getTrackFacingMode(oldVideoTrack)
    || inferFacingFromLabel(oldVideoTrack?.label)
    || activeFacingMode;
  const videoSenders = Object.values(peerConnections)
    .flatMap((pc) => pc.getSenders())
    .filter((sender) => sender.track === oldVideoTrack);

  try {
    await refreshVideoInputDevices();
    const selectedDevice = selectCameraDevice(facingMode, oldVideoTrack);
    const selectionDescription = selectedDevice?.label || `${facingLabel(facingMode)} facingMode fallback`;
    console.info('[Vyntrix] Switching camera:', {
      detectedVideoInputs: videoInputDevices.length,
      requestedFacingMode: facingMode,
      selectedLabel: selectionDescription,
      selectionMethod: selectedDevice ? 'deviceId' : 'facingMode'
    });

    // Several Android camera stacks cannot open the opposite lens while the
    // current video track owns the camera hardware. Audio remains untouched.
    detachTrackEndListener(oldVideoTrack);
    oldVideoTrack.stop();

    newVideoTrack = await acquireRequestedCamera(selectedDevice, facingMode, oldSettings.deviceId);
    const replacements = await Promise.allSettled(videoSenders.map((sender) => sender.replaceTrack(newVideoTrack)));
    if (replacements.some((result) => result.status === 'rejected')) {
      throw new Error('The live connection could not switch video tracks.');
    }

    installActiveVideoTrack(newVideoTrack, audioTracks, facingMode);
    writePreference(CAMERA_FACING_STORAGE_KEY, activeFacingMode);
    updateFacingControls(activeFacingMode, true);
    showCameraSwitchStatus(`${facingLabel(activeFacingMode)} camera active.`);
    updateCameraStatus('streaming');
    await refreshVideoInputDevices();
    return { success: true, facingMode: activeFacingMode, message: `${facingLabel(activeFacingMode)} camera active.` };
  } catch (error) {
    console.warn(`Could not switch to ${facingMode} camera:`, error?.name || 'Error', error?.message || 'Unknown error');
    newVideoTrack?.stop();
    const restoredTrack = await restorePreviousCamera(oldSettings.deviceId, previousFacingMode);
    if (restoredTrack) {
      await Promise.allSettled(videoSenders.map((sender) => sender.replaceTrack(restoredTrack)));
      installActiveVideoTrack(restoredTrack, audioTracks, previousFacingMode);
      await refreshVideoInputDevices();
      showCameraSwitchStatus(`${facingLabel(facingMode)} camera could not be opened. Previous camera restored.`, true);
    } else {
      localStream = new MediaStream(audioTracks);
      document.getElementById('webcam-preview').srcObject = localStream;
      updateCameraDiagnostics(null);
      showCameraSwitchStatus(`${facingLabel(facingMode)} camera could not be opened, and the previous camera could not be restored.`, true);
    }
    return {
      success: false,
      facingMode: activeFacingMode,
      message: restoredTrack
        ? `${facingLabel(facingMode)} camera could not be opened. Previous camera restored.`
        : `${facingLabel(facingMode)} camera could not be opened, and the previous camera could not be restored.`
    };
  } finally {
    cameraSwitchInProgress = false;
    updateFacingControls(activeFacingMode);
    updateRecordingControls();
    if (isStreaming) updateCameraStatus('streaming');
  }
}

async function stopCamera() {
  if (cameraStopInProgress) return recordingFinalizedPromise;
  cameraStopInProgress = true;
  const stopButton = document.getElementById('btn-stop');
  if (stopButton) stopButton.disabled = true;
  updateRecordingControls();

  // Finalize the Blob while tracks are available, then allow camera shutdown;
  // the authenticated upload can finish without keeping capture hardware open.
  const finalizedPromise = recordingFinalizedPromise;
  void stopRecording();
  if (finalizedPromise) await finalizedPromise;

  // Stop media tracks
  if (localStream) {
    localStream.getTracks().forEach(track => {
      detachTrackEndListener(track);
      track.stop();
    });
    localStream = null;
  }
  
  const previewEl = document.getElementById('webcam-preview');
  previewEl.srcObject = null;
  updateCameraDiagnostics(null);
  
  // Stop motion loop
  stopMotionDetection();
  
  // Close socket
  if (socket) {
    socket.disconnect();
    socket = null;
  }

  // Clean up all WebRTC peers
  Object.keys(peerConnections).forEach(monitorId => {
    cleanPeer(monitorId);
  });

  // Stop siren
  stopSiren();

  // Reset UI
  document.getElementById('btn-start').style.display = 'block';
  document.getElementById('btn-stop').style.display = 'none';
  document.getElementById('camera-name').disabled = false;
  document.getElementById('rec-indicator').style.display = 'none';
  
  isStreaming = false;
  cameraStartInProgress = false;
  cameraSwitchInProgress = false;
  cameraStopInProgress = false;
  if (stopButton) stopButton.disabled = false;
  updateFacingControls(activeFacingMode);
  updateRecordingControls();
  showCameraSwitchStatus();
  showCameraOperationMessage();
  updateCameraStatus('offline');
}

function handleLocalStreamEnded() {
  if (isStreaming) stopCamera();
}

function updateCameraStatus(status) {
  const dot = document.getElementById('camera-status-dot');
  const text = document.getElementById('camera-status-text');
  if (!dot || !text) return;

  dot.className = 'status-indicator';
  const labels = {
    connecting: 'CONNECTING',
    permission: 'AWAITING PERMISSION',
    switching: 'SWITCHING CAMERA',
    streaming: 'STREAMING',
    alerting: '🚨 ALARM TRIPPED',
    failed: 'NEEDS ATTENTION',
    offline: 'OFFLINE'
  };
  if (status === 'streaming') {
    dot.classList.add('streaming');
  } else if (status === 'alerting') {
    dot.classList.add('alerting');
  } else if (status === 'failed') {
    dot.classList.add('alerting');
  } else {
    dot.classList.add('idle');
  }
  text.innerText = labels[status] || 'OFFLINE';
}

// Socket IO setup
function connectSocket() {
  socket = io(VyntrixConfig.backendOrigin, { withCredentials: true });
  const signalingSocket = socket;
  
  signalingSocket.on('connect', () => {
    console.log('Connected to signaling server');
    signalingSocket.emit('register-device', {
      type: 'camera',
      cameraName
    });
    publishRecordingState(recordingPublicState, recordingPublicMessage);
    if (isStreaming) {
      updateCameraStatus('streaming');
      showCameraOperationMessage();
    }
  });

  signalingSocket.on('disconnect', () => {
    console.warn('Signaling server disconnected; cleaning stale monitor peers');
    Object.keys(peerConnections).forEach(cleanPeer);
    if (isStreaming) {
      updateCameraStatus('connecting');
      showCameraOperationMessage('Reconnecting to Vyntrix…');
    }
  });

  signalingSocket.on('connect_error', (error) => {
    console.error('Signaling connection failed:', error);
    if (isStreaming) {
      updateCameraStatus('connecting');
      showCameraOperationMessage('Vyntrix is reconnecting. Your camera remains active on this device.');
    }
  });

  // Relay signals
  signalingSocket.on('webrtc-signal', async ({ senderSocketId, signalData }) => {
    try {
      let pc = peerConnections[senderSocketId];
      if (pc && (pc.connectionState === 'failed' || pc.connectionState === 'closed' || pc.iceConnectionState === 'failed')) {
        cleanPeer(senderSocketId);
        pc = null;
      }
      if (!pc) {
        pc = createPeerConnection(senderSocketId, signalingSocket);
      }

      if (signalData.offer) {
        await pc.setRemoteDescription(new RTCSessionDescription(signalData.offer));
        if (peerConnections[senderSocketId] !== pc || !signalingSocket.connected) return;
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        if (peerConnections[senderSocketId] !== pc || !signalingSocket.connected) return;
        signalingSocket.emit('webrtc-signal', {
          targetSocketId: senderSocketId,
          signalData: { answer }
        });
      } else if (signalData.candidate) {
        if (peerConnections[senderSocketId] !== pc || !signalingSocket.connected) return;
        await pc.addIceCandidate(new RTCIceCandidate(signalData.candidate));
      }
    } catch (err) {
      console.error('Error handling WebRTC signal:', err);
    }
  });

  // Listen for monitor command triggers
  socket.on('trigger-siren', ({ action }) => {
    if (action === 'start') {
      startSiren();
    } else if (action === 'stop') {
      stopSiren();
    }
  });

  socket.on('camera:switch', async ({ facingMode } = {}, acknowledge) => {
    const result = await switchCamera(facingMode);
    if (typeof acknowledge === 'function') acknowledge(result);
  });

  socket.on('recording:control', async ({ action } = {}, acknowledge) => {
    const reply = typeof acknowledge === 'function' ? acknowledge : () => {};
    if (action === 'start') {
      reply(await startRecording());
      return;
    }
    if (action === 'stop') {
      if (recordingPhase !== 'recording' || !recordingIsActive()) {
        reply({ success: false, ...recordingStateSnapshot('No recording is active.') });
        return;
      }
      void stopRecording();
      reply({ success: true, ...recordingStateSnapshot('Saving recording securely…') });
      return;
    }
    reply({ success: false, ...recordingStateSnapshot('Unknown recording command.') });
  });

  socket.on('recording:state-request', (_, acknowledge) => {
    if (typeof acknowledge === 'function') {
      acknowledge({ success: true, ...recordingStateSnapshot() });
    }
  });
}

function createPeerConnection(monitorSocketId, signalingSocket = socket) {
  const pc = new RTCPeerConnection({
    iceServers
  });

  // Attach local tracks
  localStream.getTracks().forEach(track => {
    pc.addTrack(track, localStream);
  });

  // ICE candidates
  pc.onicecandidate = (event) => {
    if (event.candidate && signalingSocketIsActive(signalingSocket, monitorSocketId, pc)) {
      signalingSocket.emit('webrtc-signal', {
        targetSocketId: monitorSocketId,
        signalData: { candidate: event.candidate }
      });
    }
  };

  // Walkie Talkie: handle incoming audio track from monitor
  pc.ontrack = (event) => {
    console.log('Received track from monitor:', event.track.kind);
    if (event.track.kind === 'audio') {
      const audioStream = event.streams[0];
      
      // Play walkie-talkie speaker audio using an HTML audio element
      let monitorAudioEl = document.getElementById(`audio-speaker-${monitorSocketId}`);
      if (!monitorAudioEl) {
        monitorAudioEl = document.createElement('audio');
        monitorAudioEl.id = `audio-speaker-${monitorSocketId}`;
        monitorAudioEl.autoplay = true;
        monitorAudioEl.style.display = 'none';
        document.body.appendChild(monitorAudioEl);
      }
      monitorAudioEl.srcObject = audioStream;
    }
  };

  pc.oniceconnectionstatechange = () => {
    const state = pc.iceConnectionState;
    console.log(`Camera peer connection state: ${state}`);
    if (state === 'disconnected' || state === 'failed' || state === 'closed') {
      cleanPeer(monitorSocketId);
    }
  };

  pc.onconnectionstatechange = () => {
    const state = pc.connectionState;
    if (state === 'failed' || state === 'disconnected' || state === 'closed') {
      cleanPeer(monitorSocketId);
    }
  };

  peerConnections[monitorSocketId] = pc;
  return pc;
}

function signalingSocketIsActive(currentSocket, monitorSocketId, pc) {
  return Boolean(currentSocket && currentSocket.connected && peerConnections[monitorSocketId] === pc);
}

function cleanPeer(monitorSocketId) {
  const pc = peerConnections[monitorSocketId];
  if (pc) {
    pc.onicecandidate = null;
    pc.ontrack = null;
    pc.oniceconnectionstatechange = null;
    pc.onconnectionstatechange = null;
    pc.close();
    delete peerConnections[monitorSocketId];
  }
  const audioEl = document.getElementById(`audio-speaker-${monitorSocketId}`);
  if (audioEl) {
    audioEl.srcObject = null;
    audioEl.remove();
  }
}

// Client-Side Motion Detection Engine
function startMotionDetection() {
  if (!isStreaming || !motionDetectionEnabled || motionIntervalId) return;

  const video = document.getElementById('webcam-preview');
  const outputCanvas = document.getElementById('motion-canvas');
  const outCtx = outputCanvas.getContext('2d');

  // Small processing canvas to reduce computational overhead
  const processingCanvas = document.createElement('canvas');
  processingCanvas.width = 80;
  processingCanvas.height = 45;
  const procCtx = processingCanvas.getContext('2d');

  motionIntervalId = setInterval(() => {
    if (!motionDetectionEnabled || !isStreaming || video.paused || video.ended || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;

    // Set output overlay canvas resolution
    outputCanvas.width = video.videoWidth;
    outputCanvas.height = video.videoHeight;

    // Draw video frame to small canvas
    procCtx.drawImage(video, 0, 0, processingCanvas.width, processingCanvas.height);
    const frameData = procCtx.getImageData(0, 0, processingCanvas.width, processingCanvas.height);

    if (prevFrameData) {
      const sensitivity = parseInt(document.getElementById('motion-sensitivity').value); // 10 to 80
      
      // Scan pixels for changes
      const diff = compareFrames(prevFrameData, frameData, sensitivity);
      
      if (diff.ratio > 0.035) { // If > 3.5% of pixels changed
        // Show Motion Warning UI
        showMotionWarning();
        
        // Draw bounding box overlay in neon green
        drawMotionOverlay(outCtx, diff.boxes, video.videoWidth, video.videoHeight, processingCanvas.width, processingCanvas.height);
        
        recordMotionDetected();
      } else {
        outCtx.clearRect(0, 0, outputCanvas.width, outputCanvas.height);
        hideMotionWarning();
        recordMotionStopped();
      }
    }

    prevFrameData = frameData;
  }, 250); // Scan 4 times per second
}

function stopMotionDetection() {
  if (motionIntervalId) {
    clearInterval(motionIntervalId);
    motionIntervalId = null;
  }
  prevFrameData = null;
  resetMotionEventState();

  if (motionAlertController) {
    motionAlertController.abort();
    motionAlertController = null;
  }

  hideMotionWarning();
  
  const canvas = document.getElementById('motion-canvas');
  if (canvas) {
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }
}

function recordMotionDetected() {
  const now = Date.now();

  lastMotionDetectedAt = now;
  if (motionResetTimeoutId) {
    clearTimeout(motionResetTimeoutId);
    motionResetTimeoutId = null;
  }

  const cooldownExpired = motionEventActive
    && now - motionEventStartedAt >= MOTION_EVENT_COOLDOWN_MS;
  if (motionEventActive && !cooldownExpired) return;

  // The logical event starts independently of snapshot/upload success so a
  // failed image capture cannot cause the detector to spam retries.
  motionEventActive = true;
  motionEventStartedAt = now;
  triggerMotionAlert();
}

function recordMotionStopped() {
  if (!motionEventActive || motionResetTimeoutId) return;

  motionResetTimeoutId = setTimeout(() => {
    motionResetTimeoutId = null;
    if (Date.now() - lastMotionDetectedAt >= MOTION_RESET_MS) {
      motionEventActive = false;
      motionEventStartedAt = 0;
      lastMotionDetectedAt = 0;
    }
  }, MOTION_RESET_MS);
}

function resetMotionEventState() {
  if (motionResetTimeoutId) {
    clearTimeout(motionResetTimeoutId);
    motionResetTimeoutId = null;
  }
  motionEventActive = false;
  motionEventStartedAt = 0;
  lastMotionDetectedAt = 0;
}

function compareFrames(frameA, frameB, sensitivity) {
  const dataA = frameA.data;
  const dataB = frameB.data;
  const w = frameA.width;
  const h = frameA.height;
  
  let changedCount = 0;
  let minX = w, maxX = 0, minY = h, maxY = 0;
  
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = (y * w + x) * 4;
      
      // Grayscale conversion
      const grayA = (dataA[idx] + dataA[idx+1] + dataA[idx+2]) / 3;
      const grayB = (dataB[idx] + dataB[idx+1] + dataB[idx+2]) / 3;
      
      if (Math.abs(grayA - grayB) > sensitivity) {
        changedCount++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  const ratio = changedCount / (w * h);
  
  return {
    ratio,
    boxes: changedCount > 0 ? { minX, maxX, minY, maxY } : null
  };
}

function drawMotionOverlay(ctx, boxes, videoW, videoH, procW, procH) {
  ctx.clearRect(0, 0, videoW, videoH);
  if (!boxes) return;

  // Scale back up to full video dimensions
  const scaleX = videoW / procW;
  const scaleY = videoH / procH;

  const x = boxes.minX * scaleX;
  const y = boxes.minY * scaleY;
  const width = (boxes.maxX - boxes.minX + 1) * scaleX;
  const height = (boxes.maxY - boxes.minY + 1) * scaleY;

  // Draw bounding box
  ctx.strokeStyle = '#ff3b30'; // Crimson neon alert box
  ctx.lineWidth = 3;
  ctx.shadowColor = 'rgba(255, 59, 48, 0.6)';
  ctx.shadowBlur = 10;
  ctx.strokeRect(x, y, width, height);
  
  // Reset shadow for next draws
  ctx.shadowBlur = 0;
}

let warningTimeout = null;
function showMotionWarning() {
  const el = document.getElementById('motion-warning');
  if (el) {
    el.style.display = 'block';
    if (warningTimeout) clearTimeout(warningTimeout);
    warningTimeout = setTimeout(hideMotionWarning, 1500);
  }
}

function hideMotionWarning() {
  if (warningTimeout) {
    clearTimeout(warningTimeout);
    warningTimeout = null;
  }
  const el = document.getElementById('motion-warning');
  if (el) el.style.display = 'none';
}

// Upload motion alerts to the backend
async function triggerMotionAlert() {
  if (!isStreaming || !motionDetectionEnabled || motionAlertController) return;

  const controller = new AbortController();
  motionAlertController = controller;
  console.log('Motion event triggered! Saving metadata...');
  
  // Auto Siren Trigger
  if (document.getElementById('toggle-auto-siren').checked) {
    startSiren();
  }

  try {
    if (!isStreaming || !motionDetectionEnabled) return;

    // Send to backend
    const res = await fetch(VyntrixConfig.apiUrl('/api/alerts/upload'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      signal: controller.signal,
      body: JSON.stringify({
        cameraName
      })
    });
    
    const result = await res.json();
    if (res.ok && result.success) {
      console.log('Motion event successfully saved.');
    }
  } catch (err) {
    if (err.name !== 'AbortError') {
      console.error('Failed to save motion event:', err);
    }
  } finally {
    if (motionAlertController === controller) {
      motionAlertController = null;
    }
  }
}

// Initialise on load
document.addEventListener('DOMContentLoaded', init);
window.addEventListener('beforeunload', stopCamera);
