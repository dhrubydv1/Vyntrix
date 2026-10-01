// Monitor Dashboard Logic - Vyntrix

let socket;
let userId = null;
let activeCameraSocketId = null;
let activeCameraName = null;
let peerConnection = null;
let userNavigatedBack = false;
let availableCameras = [];
let monitorConnectionAttempt = 0;
let monitorReconnectTimer = null;
let iceServers = null;
let remoteCameraSwitchInProgress = false;
let remoteFacingMode = null;
let remoteRecordingState = 'idle';
let remoteRecordingStartedAt = null;
let remoteRecordingCommandInProgress = false;
let remoteRecordingTimerId = null;
let remoteRecordingStorageState = 'unknown';
let remoteRecordingStorageRefreshPromise = null;
let remoteRecordingQuality = '720p';
let remoteVideoWidth = null;
let remoteVideoHeight = null;
let remoteQualityChangeInProgress = false;
let remoteCameraOrientation = null;

const MONITOR_MIRROR_STORAGE_KEY = 'vyntrix.monitor.mirrorView';
const VALID_FACING_MODES = new Set(['user', 'environment']);
const VALID_RECORDING_STATES = new Set(['idle', 'recording', 'uploading', 'uploaded', 'error']);
const RECORDING_STORAGE_FULL_MESSAGE = 'No space available. Delete old recordings to continue.';

// Audio variables for Walkie Talkie mic
let micStream = null;
let micTrack = null;

// List of alerts cache
let alertsCache = [];
let activeAlert = null; // Currently opened in modal
const deletingAlertIds = new Set();

// Web Audio API for Notification chimes
let notifyCtx = null;

async function init() {
  const session = await protectPage();
  if (!session?.loggedIn) return;
  if (session.loggedIn) {
    userId = session.user.id;
    window.CCTV_USER_ID = userId;
  }

  // Load existing alert logs
  fetchAlertLogs();
  
  setupDOMListeners();
  void refreshRemoteRecordingStorageState();
  setupTimeCounter();
  try {
    iceServers = await getIceServers();
    await window.VyntrixSocketReady;
    connectSocket();
  } catch (err) {
    console.error('Monitor services could not be initialized:', err);
    updateCameraNetworkState('Vyntrix could not be reached. Check your connection and reload.', true);
    renderCameraSelectionGrid([], 'error');
  }
}

function setupDOMListeners() {
  document.getElementById('btn-back-to-list').addEventListener('click', backToCameraList);
  document.getElementById('btn-modal-close').addEventListener('click', closeAlertModal);
  document.getElementById('btn-modal-delete').addEventListener('click', deleteActiveAlert);
  document.getElementById('btn-toggle-fullscreen').addEventListener('click', toggleMonitorFullscreen);
  document.getElementById('btn-start-remote-recording').addEventListener('click', () => requestRemoteRecordingControl('start'));
  document.getElementById('btn-stop-remote-recording').addEventListener('click', () => requestRemoteRecordingControl('stop'));
  window.addEventListener('focus', () => { void refreshRemoteRecordingStorageState(); });
  
  // Close modal when clicking outside content
  window.addEventListener('click', (e) => {
    const modal = document.getElementById('snapshot-modal');
    if (e.target === modal) {
      closeAlertModal();
    }
  });

  // Digital Zoom range slider
  const zoomSlider = document.getElementById('control-zoom');
  const zoomText = document.getElementById('zoom-val');
  const videoEl = document.getElementById('remote-video');
  const mirrorToggle = document.getElementById('toggle-mirror-view');
  mirrorToggle.checked = readBooleanPreference(MONITOR_MIRROR_STORAGE_KEY);
  applyRemoteMirror(mirrorToggle.checked);
  updateRemoteRecordingQuality();

  videoEl.addEventListener('loadedmetadata', updateRemoteVideoLayout);
  videoEl.addEventListener('resize', updateRemoteVideoLayout);
  videoEl.addEventListener('webkitbeginfullscreen', updateFullscreenControls);
  videoEl.addEventListener('webkitendfullscreen', updateFullscreenControls);
  document.addEventListener('fullscreenchange', updateFullscreenControls);
  document.addEventListener('webkitfullscreenchange', updateFullscreenControls);
  configureFullscreenControl();
  updateMonitorControlAvailability();

  mirrorToggle.addEventListener('change', (event) => {
    const mirrored = event.target.checked;
    writePreference(MONITOR_MIRROR_STORAGE_KEY, String(mirrored));
    applyRemoteMirror(mirrored);
  });

  document.querySelectorAll('[data-facing-mode]').forEach((button) => {
    button.addEventListener('click', () => requestRemoteCameraSwitch(button.dataset.facingMode));
  });

  document.querySelectorAll('[data-remote-quality]').forEach((button) => {
    button.addEventListener('click', () => requestRemoteQualityChange(button.dataset.remoteQuality));
  });

  zoomSlider.addEventListener('input', (e) => {
    const val = parseFloat(e.target.value);
    zoomText.innerText = `${val}x`;
    if (videoEl) {
      videoEl.style.setProperty('--video-zoom', val);
    }
  });

  // Night Vision checkbox toggle
  const nvCheckbox = document.getElementById('control-nightvision');
  nvCheckbox.addEventListener('change', (e) => {
    if (videoEl) {
      if (e.target.checked) {
        videoEl.classList.add('night-vision-mode');
      } else {
        videoEl.classList.remove('night-vision-mode');
      }
    }
  });

  // Push to Talk (Walkie-Talkie) microphone trigger
  const pttButton = document.getElementById('btn-ptt');
  
  // Pointer and keyboard controls keep hold-to-talk usable without duplicate
  // mouse/touch events on hybrid devices.
  const startTalking = (e) => {
    e.preventDefault();
    if (!micTrack || pttButton.disabled || peerConnection?.connectionState !== 'connected') {
      console.warn('Microphone track is not active or authorized.');
      updateTalkStatus('Talk is available after the live connection and microphone are ready.', true);
      return;
    }
    pttButton.classList.add('active');
    micTrack.enabled = true; // Unmute mic track
    updateTalkStatus('Speaking to camera…');
    console.log('PTT: Microphone unmuted');
  };

  // Mouse up / Touch end / Mouse leave
  const stopTalking = (e) => {
    e.preventDefault();
    if (pttButton.classList.contains('active')) {
      pttButton.classList.remove('active');
      if (micTrack) {
        micTrack.enabled = false; // Mute mic track
      }
      updateTalkStatus('Hold to speak.');
      console.log('PTT: Microphone muted');
    }
  };

  pttButton.addEventListener('pointerdown', startTalking);
  pttButton.addEventListener('pointerup', stopTalking);
  pttButton.addEventListener('pointercancel', stopTalking);
  pttButton.addEventListener('pointerleave', stopTalking);
  pttButton.addEventListener('keydown', (event) => {
    if ((event.key === ' ' || event.key === 'Enter') && !event.repeat) startTalking(event);
  });
  pttButton.addEventListener('keyup', (event) => {
    if (event.key === ' ' || event.key === 'Enter') stopTalking(event);
  });
  window.addEventListener('blur', stopTalking);
  document.addEventListener('visibilitychange', (event) => {
    if (document.hidden) stopTalking(event);
  });
}

function updateCameraNetworkState(message, isError = false) {
  const state = document.getElementById('camera-network-state');
  if (!state) return;
  state.textContent = message;
  state.classList.toggle('is-error', isError);
}

function updateMonitorVideoState(status) {
  const overlay = document.getElementById('monitor-video-state');
  if (!overlay) return;
  const messages = {
    connecting: 'Connecting to camera…',
    reconnecting: 'Camera connection interrupted. Reconnecting…',
    disconnected: 'Camera is offline.',
    failed: 'Camera connection failed.'
  };
  overlay.textContent = messages[status] || '';
  overlay.hidden = status === 'live' || !messages[status];
  overlay.classList.toggle('is-error', status === 'failed' || status === 'disconnected');
}

function dimensionOrientation(width, height) {
  if (!width || !height) return null;
  if (height > width) return 'portrait';
  if (width > height) return 'landscape';
  return 'square';
}

function updateRemoteVideoLayout() {
  const videoEl = document.getElementById('remote-video');
  const stage = document.getElementById('remote-video-stage');
  if (!videoEl || !stage) return;
  const hasDecodedDimensions = Number.isFinite(videoEl.videoWidth) && videoEl.videoWidth > 0
    && Number.isFinite(videoEl.videoHeight) && videoEl.videoHeight > 0;
  const width = hasDecodedDimensions ? videoEl.videoWidth : null;
  const height = hasDecodedDimensions ? videoEl.videoHeight : null;
  const orientation = hasDecodedDimensions
    ? dimensionOrientation(width, height)
    : remoteCameraOrientation;
  if (!orientation) return;
  stage.classList.remove('is-portrait', 'is-landscape', 'is-square');
  stage.classList.add(`is-${orientation}`);
  stage.style.setProperty('--remote-video-aspect-ratio', hasDecodedDimensions
    ? `${width} / ${height}`
    : orientation === 'portrait' ? '9 / 16' : orientation === 'landscape' ? '16 / 9' : '1 / 1');
  stage.dataset.videoOrientation = orientation;
}

function updateRemoteCameraOrientation(update = {}) {
  if (!['portrait', 'landscape', 'square'].includes(update.orientation)) return;
  remoteCameraOrientation = update.orientation;
  // Decoded video dimensions remain authoritative. Source state only prevents
  // a fixed landscape placeholder before metadata arrives.
  updateRemoteVideoLayout();
}

function resetRemoteVideoLayout() {
  const stage = document.getElementById('remote-video-stage');
  remoteCameraOrientation = null;
  if (stage) {
    stage.classList.remove('is-portrait', 'is-landscape', 'is-square');
    stage.style.removeProperty('--remote-video-aspect-ratio');
    delete stage.dataset.videoOrientation;
  }
}

function fullscreenElement() {
  return document.fullscreenElement || document.webkitFullscreenElement || null;
}

function monitorIsFullscreen() {
  const stage = document.getElementById('remote-video-stage');
  const videoEl = document.getElementById('remote-video');
  return fullscreenElement() === stage || Boolean(videoEl?.webkitDisplayingFullscreen);
}

function configureFullscreenControl() {
  const button = document.getElementById('btn-toggle-fullscreen');
  const supported = fullscreenSupported();
  button.disabled = true;
  if (!supported) button.title = 'Full screen is not supported by this browser';
}

function updateFullscreenControls() {
  const isFullscreen = monitorIsFullscreen();
  const button = document.getElementById('btn-toggle-fullscreen');
  const label = document.getElementById('fullscreen-label');
  const icon = document.getElementById('fullscreen-icon');
  button.setAttribute('aria-pressed', String(isFullscreen));
  button.setAttribute('aria-label', isFullscreen ? 'Exit full screen' : 'Enter full screen');
  label.textContent = isFullscreen ? 'Exit Full Screen' : 'Full Screen';
  icon.textContent = isFullscreen ? '×' : '⛶';
  updateRemoteVideoLayout();
}

async function toggleMonitorFullscreen() {
  const stage = document.getElementById('remote-video-stage');
  const videoEl = document.getElementById('remote-video');
  try {
    if (monitorIsFullscreen()) {
      if (document.exitFullscreen) await document.exitFullscreen();
      else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
      else if (videoEl.webkitExitFullscreen) videoEl.webkitExitFullscreen();
      return;
    }

    if (stage.requestFullscreen) await stage.requestFullscreen();
    else if (stage.webkitRequestFullscreen) stage.webkitRequestFullscreen();
    else if (videoEl.webkitEnterFullscreen) videoEl.webkitEnterFullscreen();
  } catch (error) {
    console.warn('Could not change full-screen mode:', error?.name || 'Error', error?.message || 'Unknown error');
  }
}

function exitMonitorFullscreen() {
  if (!monitorIsFullscreen()) return;
  const videoEl = document.getElementById('remote-video');
  if (document.exitFullscreen) document.exitFullscreen().catch(() => {});
  else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
  else if (videoEl?.webkitExitFullscreen) videoEl.webkitExitFullscreen();
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
    // Display preferences are optional when browser storage is unavailable.
  }
}

function applyRemoteMirror(mirrored) {
  document.getElementById('remote-video')?.classList.toggle('video-mirrored', mirrored);
}

function fullscreenSupported() {
  const stage = document.getElementById('remote-video-stage');
  const videoEl = document.getElementById('remote-video');
  return Boolean(stage?.requestFullscreen || stage?.webkitRequestFullscreen || videoEl?.webkitEnterFullscreen);
}

function updateTalkStatus(message, isError = false) {
  const status = document.getElementById('talk-status');
  if (!status) return;
  status.textContent = message;
  status.classList.toggle('is-error', isError);
}

function updateMonitorControlAvailability() {
  const cameraAvailable = Boolean(socket?.connected && activeCameraSocketId);
  const videoEl = document.getElementById('remote-video');
  const viewAvailable = cameraAvailable && Boolean(videoEl?.srcObject);
  const recordingBlocksCameraChanges = remoteRecordingState === 'recording'
    || remoteRecordingState === 'uploading' || remoteRecordingCommandInProgress;
  const cameraChangeInProgress = remoteCameraSwitchInProgress || remoteQualityChangeInProgress;
  const startRecording = document.getElementById('btn-start-remote-recording');
  const stopRecording = document.getElementById('btn-stop-remote-recording');
  if (startRecording) startRecording.disabled = !cameraAvailable || cameraChangeInProgress
    || recordingBlocksCameraChanges || remoteRecordingStorageState === 'full';
  if (stopRecording) stopRecording.disabled = !cameraAvailable || remoteRecordingCommandInProgress
    || remoteRecordingState !== 'recording';

  document.querySelectorAll('[data-facing-mode]').forEach((button) => {
    button.disabled = !cameraAvailable || cameraChangeInProgress || recordingBlocksCameraChanges;
  });
  document.querySelectorAll('[data-remote-quality]').forEach((button) => {
    button.disabled = !cameraAvailable || cameraChangeInProgress || recordingBlocksCameraChanges;
  });

  const mirror = document.getElementById('toggle-mirror-view');
  const zoom = document.getElementById('control-zoom');
  const nightVision = document.getElementById('control-nightvision');
  const fullscreen = document.getElementById('btn-toggle-fullscreen');
  if (mirror) mirror.disabled = !viewAvailable;
  if (zoom) zoom.disabled = !viewAvailable;
  if (nightVision) nightVision.disabled = !viewAvailable;
  if (fullscreen) fullscreen.disabled = !viewAvailable || !fullscreenSupported();

  const talk = document.getElementById('btn-ptt');
  const talkAvailable = viewAvailable && peerConnection?.connectionState === 'connected'
    && micTrack?.readyState === 'live';
  if (talk) talk.disabled = !talkAvailable;
  if (!talkAvailable) {
    if (micTrack) micTrack.enabled = false;
    talk?.classList.remove('active');
  }
  if (!cameraAvailable) updateTalkStatus('Connect to a camera to talk.');
  else if (!micTrack) updateTalkStatus('Microphone access is required to talk.', true);
  else if (!talkAvailable) updateTalkStatus('Talk will be available when the live connection is ready.');
  else if (!talk?.classList.contains('active')) updateTalkStatus('Hold to speak.');
}

function updateRemoteFacingControls(facingMode = null, disabled = remoteCameraSwitchInProgress) {
  if (VALID_FACING_MODES.has(facingMode)) remoteFacingMode = facingMode;
  document.querySelectorAll('[data-facing-mode]').forEach((button) => {
    button.setAttribute('aria-pressed', String(button.dataset.facingMode === remoteFacingMode));
  });
  remoteCameraSwitchInProgress = disabled;
  updateMonitorControlAvailability();
}

function updateRemoteRecordingQuality(quality = '720p', width = null, height = null, message = '', isError = false) {
  remoteRecordingQuality = VyntrixRecordingQuality.normalizeQuality(quality);
  const hasResolution = Number.isSafeInteger(width) && width > 0 && Number.isSafeInteger(height) && height > 0;
  remoteVideoWidth = hasResolution ? width : null;
  remoteVideoHeight = hasResolution ? height : null;
  const qualityElement = document.getElementById('remote-recording-quality');
  const resolutionElement = document.getElementById('remote-stream-resolution');
  const status = document.getElementById('remote-quality-status');
  const estimate = document.getElementById('remote-recording-quality-estimate');
  if (qualityElement) qualityElement.textContent = remoteRecordingQuality;
  if (resolutionElement) {
    resolutionElement.textContent = remoteVideoWidth && remoteVideoHeight
      ? `${remoteVideoWidth} × ${remoteVideoHeight}`
      : 'Resolution unavailable';
  }
  document.querySelectorAll('[data-remote-quality]').forEach((button) => {
    button.setAttribute('aria-pressed', String(button.dataset.remoteQuality === remoteRecordingQuality));
  });
  if (status) {
    status.textContent = message || (remoteVideoWidth && remoteVideoHeight
      ? `${remoteVideoWidth} × ${remoteVideoHeight} active`
      : 'Waiting for the camera to report its resolution.');
    status.classList.toggle('is-error', isError);
  }
  if (estimate) estimate.textContent = `${VyntrixRecordingQuality.estimateLabel(remoteRecordingQuality)} on the camera device`;
  updateMonitorControlAvailability();
}

function formatRemoteRecordingElapsed(totalSeconds) {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const base = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  return hours ? `${String(hours).padStart(2, '0')}:${base}` : base;
}

function updateRemoteRecordingTimer() {
  const elapsed = document.getElementById('remote-recording-elapsed');
  if (!elapsed || !remoteRecordingStartedAt) return;
  const totalSeconds = Math.max(0, Math.floor((Date.now() - remoteRecordingStartedAt) / 1000));
  elapsed.textContent = formatRemoteRecordingElapsed(totalSeconds);
  elapsed.dateTime = `PT${totalSeconds}S`;
}

function stopRemoteRecordingTimer({ reset = false } = {}) {
  if (remoteRecordingTimerId) {
    clearInterval(remoteRecordingTimerId);
    remoteRecordingTimerId = null;
  }
  if (reset) {
    remoteRecordingStartedAt = null;
    const elapsed = document.getElementById('remote-recording-elapsed');
    if (elapsed) {
      elapsed.textContent = '00:00';
      elapsed.dateTime = 'PT0S';
    }
  }
}

function refreshRemoteRecordingStorageState() {
  if (remoteRecordingStorageRefreshPromise) return remoteRecordingStorageRefreshPromise;
  remoteRecordingStorageRefreshPromise = fetch(VyntrixConfig.apiUrl('/api/recordings/storage'), {
    credentials: 'include'
  })
    .then(async (response) => {
      if (!response.ok) throw new Error('Storage request failed');
      const storage = await response.json();
      if (['normal', 'warning', 'full'].includes(storage.globalState)) {
        remoteRecordingStorageState = storage.globalState;
      }
      applyRemoteRecordingState({
        state: remoteRecordingState,
        startedAt: remoteRecordingStartedAt ? new Date(remoteRecordingStartedAt).toISOString() : null,
        message: remoteRecordingStorageState === 'full' ? RECORDING_STORAGE_FULL_MESSAGE : ''
      }, { forceError: remoteRecordingStorageState === 'full' });
      return remoteRecordingStorageState;
    })
    .catch((error) => {
      console.warn('Recording storage state could not be refreshed:', error?.name || 'Error');
      return remoteRecordingStorageState;
    })
    .finally(() => { remoteRecordingStorageRefreshPromise = null; });
  return remoteRecordingStorageRefreshPromise;
}

function applyRemoteRecordingState(update = {}, { forceError = false } = {}) {
  if (!VALID_RECORDING_STATES.has(update.state)) return;
  remoteRecordingState = update.state;
  const parsedStartedAt = typeof update.startedAt === 'string' ? Date.parse(update.startedAt) : NaN;
  if (!Number.isNaN(parsedStartedAt)) remoteRecordingStartedAt = parsedStartedAt;
  if (update.state === 'idle') stopRemoteRecordingTimer({ reset: true });
  else if (update.state === 'recording') {
    if (!remoteRecordingStartedAt) remoteRecordingStartedAt = Date.now();
    stopRemoteRecordingTimer();
    updateRemoteRecordingTimer();
    remoteRecordingTimerId = setInterval(updateRemoteRecordingTimer, 1000);
  } else {
    stopRemoteRecordingTimer();
    updateRemoteRecordingTimer();
  }

  const card = document.querySelector('.remote-recording-card');
  const state = document.getElementById('remote-recording-state');
  const feedback = document.getElementById('remote-recording-feedback');
  const startButton = document.getElementById('btn-start-remote-recording');
  const stopButton = document.getElementById('btn-stop-remote-recording');
  const labels = {
    idle: remoteRecordingStorageState === 'full'
      ? 'No space available'
      : activeCameraSocketId ? 'Ready to record' : 'Connect to a camera to record',
    recording: 'Recording in progress',
    uploading: 'Stopping and uploading…',
    uploaded: 'Recording uploaded',
    error: 'Recording needs attention'
  };
  card?.classList.toggle('is-recording', update.state === 'recording');
  card?.classList.toggle('is-uploading', update.state === 'uploading');
  if (state) state.textContent = labels[update.state];
  if (feedback) {
    feedback.textContent = update.message || '';
    feedback.classList.toggle('is-error', forceError || update.state === 'error');
  }
  if (startButton && stopButton) {
    const busy = remoteRecordingCommandInProgress;
    startButton.hidden = update.state === 'recording' || update.state === 'uploading';
    stopButton.hidden = update.state !== 'recording' && update.state !== 'uploading';
    startButton.disabled = busy || remoteCameraSwitchInProgress || remoteQualityChangeInProgress || !activeCameraSocketId || !socket?.connected
      || remoteRecordingStorageState === 'full';
    stopButton.disabled = busy || update.state !== 'recording' || !socket?.connected;
    stopButton.textContent = update.state === 'uploading' ? 'Uploading…' : 'Stop Recording';
  }
  updateRemoteFacingControls(remoteFacingMode, remoteCameraSwitchInProgress);
}

function requestRemoteRecordingState() {
  if (!socket?.connected || !activeCameraSocketId) {
    applyRemoteRecordingState({ state: 'idle' });
    return;
  }
  const targetSocketId = activeCameraSocketId;
  const attempt = monitorConnectionAttempt;
  socket.timeout(5000).emit('recording:state-request', {
    targetSocketId
  }, (timeoutError, response) => {
    if (attempt !== monitorConnectionAttempt || targetSocketId !== activeCameraSocketId) return;
    if (timeoutError || !response?.success) {
      applyRemoteRecordingState({
        state: 'error',
        message: response?.message || 'Recording state could not be confirmed.'
      }, { forceError: true });
      return;
    }
    applyRemoteRecordingState(response);
  });
}

async function requestRemoteRecordingControl(action) {
  if (!['start', 'stop'].includes(action) || remoteRecordingCommandInProgress
    || remoteCameraSwitchInProgress || remoteQualityChangeInProgress) return;
  if (!socket?.connected || !activeCameraSocketId) {
    applyRemoteRecordingState({ state: 'error', message: 'Connect to a camera before recording.' }, { forceError: true });
    return;
  }
  if ((action === 'start' && ['recording', 'uploading'].includes(remoteRecordingState))
    || (action === 'stop' && remoteRecordingState !== 'recording')) return;
  const targetSocketId = activeCameraSocketId;
  const attempt = monitorConnectionAttempt;
  remoteRecordingCommandInProgress = true;
  updateMonitorControlAvailability();
  if (action === 'start') {
    await refreshRemoteRecordingStorageState();
    if (attempt !== monitorConnectionAttempt || targetSocketId !== activeCameraSocketId) return;
    if (!socket?.connected || ['recording', 'uploading'].includes(remoteRecordingState)) {
      remoteRecordingCommandInProgress = false;
      applyRemoteRecordingState({ state: remoteRecordingState });
      return;
    }
    if (remoteRecordingStorageState === 'full') {
      remoteRecordingCommandInProgress = false;
      applyRemoteRecordingState({ state: 'error', message: RECORDING_STORAGE_FULL_MESSAGE }, { forceError: true });
      return;
    }
  }

  remoteRecordingCommandInProgress = true;
  applyRemoteRecordingState({
    state: remoteRecordingState,
    startedAt: remoteRecordingStartedAt ? new Date(remoteRecordingStartedAt).toISOString() : null,
    message: action === 'start' ? 'Starting recording…' : 'Stopping recording…'
  });
  socket.timeout(12000).emit('recording:control', {
    targetSocketId,
    action
  }, (timeoutError, response) => {
    if (attempt !== monitorConnectionAttempt || targetSocketId !== activeCameraSocketId) return;
    remoteRecordingCommandInProgress = false;
    if (timeoutError || !response?.success) {
      applyRemoteRecordingState({
        state: VALID_RECORDING_STATES.has(response?.state) ? response.state : remoteRecordingState,
        startedAt: response?.startedAt || null,
        message: response?.message || 'The camera did not respond. Try again.'
      }, { forceError: true });
      if (response?.message === RECORDING_STORAGE_FULL_MESSAGE) {
        void refreshRemoteRecordingStorageState();
      }
      return;
    }
    applyRemoteRecordingState(response);
  });
}

function requestRemoteQualityChange(quality) {
  const normalized = VyntrixRecordingQuality.normalizeQuality(quality);
  if (normalized !== quality || remoteQualityChangeInProgress || remoteCameraSwitchInProgress
    || remoteRecordingCommandInProgress) return;
  if (remoteRecordingState === 'recording' || remoteRecordingState === 'uploading') {
    updateRemoteRecordingQuality(
      remoteRecordingQuality,
      remoteVideoWidth,
      remoteVideoHeight,
      'Stop the current recording before changing quality.',
      true
    );
    return;
  }
  if (!socket?.connected || !activeCameraSocketId) {
    updateRemoteRecordingQuality(
      remoteRecordingQuality,
      remoteVideoWidth,
      remoteVideoHeight,
      'Connect to a camera before changing quality.',
      true
    );
    return;
  }

  remoteQualityChangeInProgress = true;
  const targetSocketId = activeCameraSocketId;
  const attempt = monitorConnectionAttempt;
  updateRemoteRecordingQuality(
    remoteRecordingQuality,
    remoteVideoWidth,
    remoteVideoHeight,
    `Requesting ${normalized}…`
  );
  socket.timeout(12000).emit('camera:quality:set', {
    targetSocketId,
    quality: normalized
  }, (timeoutError, response) => {
    if (attempt !== monitorConnectionAttempt || targetSocketId !== activeCameraSocketId) return;
    remoteQualityChangeInProgress = false;
    if (timeoutError || !response?.success) {
      updateRemoteRecordingQuality(
        remoteRecordingQuality,
        remoteVideoWidth,
        remoteVideoHeight,
        response?.message || 'The camera did not respond. Try again.',
        true
      );
      return;
    }
    updateRemoteRecordingQuality(
      response.quality,
      response.width,
      response.height,
      response.message || `${response.width} × ${response.height} applied.`
    );
  });
}

function showRemoteCameraSwitchStatus(message = '', isError = false) {
  const status = document.getElementById('remote-camera-switch-status');
  if (!status) return;
  status.textContent = message;
  status.classList.toggle('is-error', isError);
}

function requestRemoteCameraSwitch(facingMode) {
  if (!VALID_FACING_MODES.has(facingMode) || remoteCameraSwitchInProgress
    || remoteQualityChangeInProgress || remoteRecordingCommandInProgress) return;
  if (remoteRecordingState === 'recording' || remoteRecordingState === 'uploading') {
    showRemoteCameraSwitchStatus('Stop the current recording before switching cameras.', true);
    return;
  }
  if (!socket?.connected || !activeCameraSocketId) {
    showRemoteCameraSwitchStatus('Connect to a camera before switching.', true);
    return;
  }

  remoteCameraSwitchInProgress = true;
  const targetSocketId = activeCameraSocketId;
  const attempt = monitorConnectionAttempt;
  updateRemoteFacingControls(null, true);
  showRemoteCameraSwitchStatus(`Requesting ${facingMode === 'user' ? 'front' : 'back'} camera…`);
  socket.timeout(12000).emit('camera:switch', {
    targetSocketId,
    facingMode
  }, (timeoutError, result) => {
    if (attempt !== monitorConnectionAttempt || targetSocketId !== activeCameraSocketId) return;
    remoteCameraSwitchInProgress = false;
    const response = timeoutError ? null : result;
    if (response?.success && VALID_FACING_MODES.has(response.facingMode)) {
      updateRemoteFacingControls(response.facingMode);
      if (response.quality && response.width && response.height) {
        updateRemoteRecordingQuality(response.quality, response.width, response.height);
      }
      showRemoteCameraSwitchStatus(response.message || 'Camera switched.');
      updateRemoteVideoLayout();
      return;
    }
    updateRemoteFacingControls(response?.facingMode || null);
    showRemoteCameraSwitchStatus(response?.message || 'The camera did not confirm an applied lens. Try again.', true);
  });
}

function setupTimeCounter() {
  setInterval(() => {
    const now = new Date();
    const timeStr = now.toISOString().replace('T', ' ').substring(0, 19);
    const el = document.getElementById('monitor-time');
    if (el) el.innerText = timeStr;
  }, 1000);
}

// Socket IO Setup
function connectSocket() {
  socket = io(VyntrixConfig.backendOrigin, { withCredentials: true });

  socket.on('connect', () => {
    console.log('Connected to signaling server');
    updateMonitorStatus(activeCameraSocketId ? 'reconnecting' : 'connecting');
    socket.emit('register-device', {
      type: 'monitor'
    });
    updateCameraNetworkState('Looking for online cameras…');
  });

  socket.on('disconnect', () => {
    console.warn('Signaling server disconnected');
    cleanupPeerConnection();
    if (activeCameraSocketId) updateMonitorStatus('reconnecting');
    if (remoteRecordingState === 'recording' || remoteRecordingState === 'uploading') {
      applyRemoteRecordingState({
        state: 'error',
        startedAt: remoteRecordingStartedAt ? new Date(remoteRecordingStartedAt).toISOString() : null,
        message: 'Camera connection was lost while recording. Reconnect to confirm its status.'
      }, { forceError: true });
    }
    updateCameraNetworkState('Connection interrupted. Reconnecting…');
  });

  socket.on('connect_error', (error) => {
    console.error('Signaling connection failed:', error);
    updateCameraNetworkState('Vyntrix is waking up or temporarily unreachable. Reconnecting…', true);
    if (activeCameraSocketId) updateMonitorStatus('reconnecting');
  });

  // Camera devices update in workspace
  socket.on('camera-list-update', (cameras) => {
    availableCameras = Array.isArray(cameras) ? cameras : [];
    updateCameraNetworkState(availableCameras.length ? `${availableCameras.length} camera${availableCameras.length === 1 ? '' : 's'} online` : 'No cameras are currently online.');
    renderCameraSelectionGrid(availableCameras);
    const selectedCamera = availableCameras.find(camera => camera.socketId === activeCameraSocketId);
    if (selectedCamera?.recordingQuality) {
      updateRemoteRecordingQuality(
        selectedCamera.recordingQuality,
        selectedCamera.videoWidth,
        selectedCamera.videoHeight
      );
    }
    if (selectedCamera?.facingMode) updateRemoteFacingControls(selectedCamera.facingMode);
    if (selectedCamera?.orientation) updateRemoteCameraOrientation(selectedCamera);
    if (selectedCamera?.recordingState) {
      applyRemoteRecordingState({
        state: selectedCamera.recordingState,
        startedAt: selectedCamera.recordingStartedAt
      });
    }
    reconnectToSelectedCamera();
  });

  socket.on('recording:state', (stateUpdate) => {
    if (stateUpdate?.cameraSocketId !== activeCameraSocketId) return;
    applyRemoteRecordingState(stateUpdate);
    if (stateUpdate.state === 'uploaded'
      || stateUpdate.message === RECORDING_STORAGE_FULL_MESSAGE) {
      void refreshRemoteRecordingStorageState();
    }
  });

  socket.on('camera:quality', (qualityUpdate) => {
    if (qualityUpdate?.cameraSocketId !== activeCameraSocketId) return;
    updateRemoteRecordingQuality(
      qualityUpdate.quality,
      qualityUpdate.width,
      qualityUpdate.height,
      qualityUpdate.message || ''
    );
  });

  socket.on('camera:orientation', (orientationUpdate) => {
    if (orientationUpdate?.cameraSocketId !== activeCameraSocketId) return;
    updateRemoteCameraOrientation(orientationUpdate);
  });

  // Signal feedback from camera
  socket.on('webrtc-signal', async ({ senderSocketId, signalData }) => {
    if (senderSocketId !== activeCameraSocketId) return;

    if (!peerConnection || peerConnection.connectionState === 'closed') return;
    const signalPeer = peerConnection;

    try {
      if (signalData.answer) {
        await signalPeer.setRemoteDescription(new RTCSessionDescription(signalData.answer));
        console.log('WebRTC connection established with camera answer');
      } else if (signalData.candidate) {
        if (peerConnection !== signalPeer) return;
        await signalPeer.addIceCandidate(new RTCIceCandidate(signalData.candidate));
      }
    } catch (err) {
      console.error('Failed to process incoming WebRTC signal:', err);
    }
  });

  // Real-time Motion Alert logger
  socket.on('motion-alert', (alert) => {
    // Add alert to top of feed list
    alertsCache.unshift(alert);
    renderAlertList();
    
    // Highlight list item and play visual warning if alert is for the active viewed camera
    if (activeCameraName && alert.cameraName === activeCameraName) {
      playAlertNotification();
    } else {
      // Just play warning chime anyway
      playAlertNotification();
    }
  });
}

// Plays a premium dual-tone chime notification on motion
function playAlertNotification() {
  try {
    if (!notifyCtx) {
      notifyCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    
    const now = notifyCtx.currentTime;
    
    // Note 1: C5 (523 Hz)
    const osc1 = notifyCtx.createOscillator();
    const gain1 = notifyCtx.createGain();
    osc1.type = 'triangle';
    osc1.frequency.setValueAtTime(523, now);
    gain1.gain.setValueAtTime(0.3, now);
    gain1.gain.exponentialRampToValueAtTime(0.01, now + 0.15);
    osc1.connect(gain1);
    gain1.connect(notifyCtx.destination);
    
    // Note 2: E5 (659 Hz)
    const osc2 = notifyCtx.createOscillator();
    const gain2 = notifyCtx.createGain();
    osc2.type = 'triangle';
    osc2.frequency.setValueAtTime(659, now + 0.1);
    gain2.gain.setValueAtTime(0.3, now + 0.1);
    gain2.gain.exponentialRampToValueAtTime(0.01, now + 0.3);
    osc2.connect(gain2);
    gain2.connect(notifyCtx.destination);

    osc1.start(now);
    osc1.stop(now + 0.2);
    
    osc2.start(now + 0.1);
    osc2.stop(now + 0.35);
  } catch (err) {
    console.error('Audio chime playback failed:', err);
  }
}

// Populate grid with online cameras
function renderCameraSelectionGrid(cameras, state = 'ready') {
  const container = document.getElementById('camera-list-container');
  if (!container) return;
  if (activeCameraSocketId && !cameras.some(camera => camera.socketId === activeCameraSocketId)) {
    cleanupPeerConnection();
    activeCameraSocketId = null;
    remoteVideoWidth = null;
    remoteVideoHeight = null;
    updateMonitorControlAvailability();
    document.getElementById('monitor-portal-view').style.display = 'none';
    document.getElementById('camera-selection-view').style.display = 'block';
    updateMonitorStatus('disconnected');
  }

  if (cameras.length === 0) {
    userNavigatedBack = false; // Reset block since all cameras went offline
    container.innerHTML = `
      <div class="camera-empty-state">
        <div class="empty-state-icon" aria-hidden="true">📹</div>
        <h4>${state === 'error' ? 'Camera network unavailable' : 'No cameras online'}</h4>
        <p>${state === 'error' ? 'Check your connection, then reload this page.' : 'Open Vyntrix on another phone or computer, name the camera, and select <strong>Start Camera</strong>.'}</p>
        ${state === 'error' ? '<a href="/monitor.html" class="btn btn-glass">Try Again</a>' : '<a href="/camera.html" target="_blank" rel="noopener" class="btn btn-glass">Open Camera Console</a>'}
      </div>
    `;
    return;
  }

  // Auto-connect if there is exactly 1 camera online and we haven't manually backed out
  if (cameras.length === 1 && activeCameraSocketId === null && !userNavigatedBack) {
    initiateStreaming(cameras[0].socketId, cameras[0].cameraName);
    return;
  }

  container.innerHTML = '';
  cameras.forEach(cam => {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'camera-card';
    const icon = document.createElement('div');
    icon.className = 'camera-card-icon';
    icon.textContent = '📹';
    const name = document.createElement('div');
    name.className = 'camera-card-name';
    name.textContent = cam.cameraName;
    const status = document.createElement('div');
    status.className = 'camera-card-status';
    status.textContent = '● ACTIVE';
    card.append(icon, name, status);
    card.addEventListener('click', () => initiateStreaming(cam.socketId, cam.cameraName));
    container.appendChild(card);
  });
}

function updateMonitorStatus(status) {
  const indicator = document.querySelector('.stream-status .status-indicator');
  const text = document.getElementById('monitor-connection-status');
  if (!indicator || !text) return;

  indicator.className = 'status-indicator';
  const labels = {
    connecting: 'CONNECTING',
    live: 'LIVE',
    reconnecting: 'RECONNECTING',
    disconnected: 'DISCONNECTED',
    failed: 'FAILED'
  };
  indicator.classList.add(`status-${status}`);
  if (status === 'live') indicator.classList.add('streaming');
  else if (status === 'failed') indicator.classList.add('alerting');
  else indicator.classList.add('idle');
  text.innerText = labels[status] || 'DISCONNECTED';
  updateMonitorVideoState(status);
  updateMonitorControlAvailability();
}

function cleanupPeerConnection() {
  monitorConnectionAttempt += 1;
  remoteCameraSwitchInProgress = false;
  remoteQualityChangeInProgress = false;
  remoteRecordingCommandInProgress = false;
  if (monitorReconnectTimer) {
    clearTimeout(monitorReconnectTimer);
    monitorReconnectTimer = null;
  }
  if (peerConnection) {
    const stalePeer = peerConnection;
    peerConnection = null;
    stalePeer.onicecandidate = null;
    stalePeer.ontrack = null;
    stalePeer.onconnectionstatechange = null;
    stalePeer.oniceconnectionstatechange = null;
    stalePeer.close();
  }
  const videoEl = document.getElementById('remote-video');
  if (videoEl) videoEl.srcObject = null;
  resetRemoteVideoLayout();
  updateMonitorControlAvailability();
}

function reconnectToSelectedCamera() {
  if (!activeCameraName || !socket || !socket.connected || peerConnection) return;
  const camera = availableCameras.find(item => item.cameraName === activeCameraName);
  if (!camera) {
    activeCameraSocketId = null;
    updateMonitorStatus('disconnected');
    return;
  }
  activeCameraSocketId = camera.socketId;
  initiateStreaming(camera.socketId, camera.cameraName, true);
}

async function ensureMicrophoneTrack() {
  const pttButton = document.getElementById('btn-ptt');
  if (micTrack?.readyState === 'live' && micStream) {
    updateMonitorControlAvailability();
    return micTrack;
  }
  micStream?.getTracks().forEach(track => track.stop());
  micStream = null;
  micTrack = null;
  pttButton.disabled = true;
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    micTrack = micStream.getAudioTracks()[0] || null;
    if (micTrack) micTrack.enabled = false;
    pttButton.title = micTrack ? '' : 'Microphone is unavailable';
    updateTalkStatus(micTrack ? 'Talk will be available when the live connection is ready.' : 'No microphone is available.', !micTrack);
  } catch (err) {
    console.warn('Microphone permission denied. Walkie-Talkie feature disabled:', err);
    pttButton.title = 'Allow microphone access to use Talk';
    updateTalkStatus('Microphone permission was not granted.', true);
  }
  updateMonitorControlAvailability();
  return micTrack;
}

// Initiate peer collection & stream setup
async function initiateStreaming(socketId, name, isReconnect = false) {
  if (!socket || !socket.connected) {
    updateMonitorStatus('reconnecting');
    return;
  }
  if (peerConnection && activeCameraSocketId === socketId) return;
  cleanupPeerConnection();
  const attempt = ++monitorConnectionAttempt;
  activeCameraSocketId = socketId;
  activeCameraName = name;
  const selectedCamera = availableCameras.find(camera => camera.socketId === socketId);
  updateRemoteRecordingQuality(
    selectedCamera?.recordingQuality || '720p',
    selectedCamera?.videoWidth || null,
    selectedCamera?.videoHeight || null
  );
  remoteFacingMode = VALID_FACING_MODES.has(selectedCamera?.facingMode) ? selectedCamera.facingMode : null;
  updateRemoteCameraOrientation(selectedCamera || {});
  updateMonitorStatus(isReconnect ? 'reconnecting' : 'connecting');

  // Swap view states
  document.getElementById('camera-selection-view').style.display = 'none';
  document.getElementById('monitor-portal-view').style.display = 'grid';
  document.getElementById('active-camera-title').innerText = name;

  // Reset controls UI
  document.getElementById('control-zoom').value = 1;
  document.getElementById('zoom-val').innerText = '1x';
  document.getElementById('control-nightvision').checked = false;
  updateRemoteFacingControls();
  showRemoteCameraSwitchStatus();
  applyRemoteRecordingState({ state: 'idle' });
  requestRemoteRecordingState();
  
  const videoEl = document.getElementById('remote-video');
  videoEl.classList.remove('night-vision-mode');
  videoEl.style.setProperty('--video-zoom', 1);

  // Reuse one microphone stream across reconnect attempts.
  await ensureMicrophoneTrack();

  if (attempt !== monitorConnectionAttempt || !activeCameraSocketId) return;

  // Create Peer Connection
  peerConnection = new RTCPeerConnection({
    iceServers
  });

  // The monitor is the offerer, so explicitly negotiate a receive-only
  // video m-line for the camera's remote video track.
  peerConnection.addTransceiver('video', { direction: 'recvonly' });

  // Attach Microphone track if available
  if (micTrack && micStream) {
    peerConnection.addTrack(micTrack, micStream);
  }

  // Gather ICE candidates
  peerConnection.onicecandidate = (event) => {
    if (event.candidate && socket && socket.connected && peerConnection === thisPeer && attempt === monitorConnectionAttempt) {
      socket.emit('webrtc-signal', {
        targetSocketId: socketId,
        signalData: { candidate: event.candidate }
      });
    }
  };

  // Receive tracks from camera
  peerConnection.ontrack = (event) => {
    console.log('Received track from camera:', event.track.kind);
    if (event.track.kind === 'video') {
      videoEl.srcObject = event.streams[0];
      updateRemoteVideoLayout();
      updateMonitorControlAvailability();
    }
  };

  const thisPeer = peerConnection;
  peerConnection.oniceconnectionstatechange = () => {
    const state = thisPeer.iceConnectionState;
    console.log(`ICE Connection State: ${state}`);
    if (state === 'disconnected') updateMonitorStatus('reconnecting');
    if (state === 'failed') handlePeerFailure(thisPeer, 'failed');
    if (state === 'closed') handlePeerFailure(thisPeer, 'disconnected');
  };

  peerConnection.onconnectionstatechange = () => {
    const state = thisPeer.connectionState;
    if (state === 'connected') updateMonitorStatus('live');
    else if (state === 'connecting' || state === 'new') updateMonitorStatus('connecting');
    else if (state === 'disconnected') updateMonitorStatus('reconnecting');
    else if (state === 'failed') handlePeerFailure(thisPeer, 'failed');
    else if (state === 'closed') handlePeerFailure(thisPeer, 'disconnected');
  };

  // Create Offer
  try {
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    
    if (attempt !== monitorConnectionAttempt || !socket.connected || peerConnection !== thisPeer) return;
    socket.emit('webrtc-signal', {
      targetSocketId: socketId,
      signalData: { offer }
    });
  } catch (err) {
    console.error('Failed to negotiate WebRTC offer:', err);
  }
}

function handlePeerFailure(peer, status) {
  if (peerConnection !== peer) return;
  cleanupPeerConnection();
  updateMonitorStatus(status);
  if (activeCameraName && socket && socket.connected) {
    updateMonitorStatus('reconnecting');
    monitorReconnectTimer = setTimeout(reconnectToSelectedCamera, 500);
  }
}

function backToCameraList() {
  const hadActiveCamera = Boolean(activeCameraSocketId);
  activeCameraSocketId = null;
  activeCameraName = null;
  userNavigatedBack = true; // Block auto-connecting until reset
  exitMonitorFullscreen();
  remoteCameraSwitchInProgress = false;
  remoteRecordingCommandInProgress = false;
  remoteQualityChangeInProgress = false;
  remoteFacingMode = null;
  remoteVideoWidth = null;
  remoteVideoHeight = null;
  updateRemoteFacingControls();
  updateRemoteRecordingQuality(remoteRecordingQuality, null, null, 'Connect to a camera to change quality.');
  showRemoteCameraSwitchStatus();
  applyRemoteRecordingState({ state: 'idle' });

  // Stop video element
  const videoEl = document.getElementById('remote-video');
  if (videoEl) videoEl.srcObject = null;

  // Clean WebRTC
  cleanupPeerConnection();

  // Clean Microphone stream
  if (micStream) {
    micStream.getTracks().forEach(track => track.stop());
    micStream = null;
    micTrack = null;
  }
  document.getElementById('btn-ptt').disabled = true;

  // Swap view states
  document.getElementById('monitor-portal-view').style.display = 'none';
  document.getElementById('camera-selection-view').style.display = 'block';
  updateMonitorStatus(hadActiveCamera ? 'disconnected' : 'connecting');
}

// Fetch historical alert logs from database
async function fetchAlertLogs() {
  const status = document.getElementById('alerts-status');
  status.textContent = 'Loading motion events…';
  status.classList.remove('is-error');
  try {
    const res = await fetch(VyntrixConfig.apiUrl('/api/alerts'), { credentials: 'include' });
    if (!res.ok) throw new Error(`Alert request returned ${res.status}`);
    const data = await res.json();
    alertsCache = Array.isArray(data.alerts) ? data.alerts : [];
    renderAlertList();
    status.textContent = '';
  } catch (err) {
    console.error('Failed to retrieve alert logs:', err);
    status.textContent = 'Motion events could not be loaded. Check your connection and try again.';
    status.classList.add('is-error');
  }
}

function renderAlertList() {
  const list = document.getElementById('alerts-list');
  const countEl = document.getElementById('alerts-count');
  const emptyState = document.getElementById('alerts-empty-state');
  if (!list) return;

  if (alertsCache.length === 0) {
    emptyState.style.display = 'block';
    countEl.innerText = '0 logs';
    // Clear other list elements
    const alertsElements = list.querySelectorAll('.alert-item');
    alertsElements.forEach(el => el.remove());
    return;
  }

  emptyState.style.display = 'none';
  countEl.innerText = `${alertsCache.length} log${alertsCache.length > 1 ? 's' : ''}`;

  // Clear existing items but preserve empty state structure
  const currentItems = list.querySelectorAll('.alert-item');
  currentItems.forEach(el => el.remove());

  alertsCache.forEach((alert) => {
    const item = document.createElement('div');
    // Highlight first item if it was just loaded via socket (timestamp check/index 0)
    item.className = 'alert-item';
    
    // Check if alert timestamp is less than 5 seconds old (fresh real-time trigger)
    const ageMs = Date.now() - new Date(alert.timestamp).getTime();
    if (ageMs < 5000) {
      item.classList.add('new-alert');
    }

    const date = new Date(alert.timestamp);
    const dateStr = date.toLocaleTimeString() + ' - ' + date.toLocaleDateString();

    const thumbnail = document.createElement('div');
    thumbnail.className = 'alert-thumbnail';
    if (alert.imagePath) {
      const image = document.createElement('img');
      image.src = VyntrixConfig.apiUrl(alert.imagePath);
      image.alt = 'Alert thumbnail';
      thumbnail.appendChild(image);
    } else {
      const placeholder = document.createElement('span');
      placeholder.className = 'alert-thumbnail-placeholder';
      placeholder.textContent = 'Motion';
      placeholder.setAttribute('aria-label', 'Motion event without snapshot');
      thumbnail.appendChild(placeholder);
      item.classList.add('metadata-only');
    }
    const info = document.createElement('div');
    info.className = 'alert-info';
    const camera = document.createElement('span');
    camera.className = 'alert-camera';
    camera.textContent = alert.cameraName;
    const timestamp = document.createElement('span');
    timestamp.className = 'alert-time';
    timestamp.textContent = dateStr;
    info.append(camera, timestamp);
    const remove = document.createElement('button');
    remove.className = 'alert-delete-btn';
    remove.type = 'button';
    remove.title = 'Delete event';
    remove.setAttribute('aria-label', `Delete motion event from ${alert.cameraName}`);
    remove.textContent = '×';
    remove.addEventListener('click', (event) => {
      event.stopPropagation();
      deleteAlertItem(alert.id, remove);
    });
    item.append(thumbnail, info, remove);

    // Click handler to open screenshot modal
    item.addEventListener('click', () => {
      if (alert.imagePath) openAlertModal(alert);
    });

    list.appendChild(item);
  });
}

function openAlertModal(alert) {
  activeAlert = alert;
  
  document.getElementById('modal-camera-name').innerText = alert.cameraName;
  document.getElementById('modal-image').src = VyntrixConfig.apiUrl(alert.imagePath);
  
  const date = new Date(alert.timestamp);
  document.getElementById('modal-timestamp').innerText = date.toLocaleString();
  
  document.getElementById('snapshot-modal').style.display = 'flex';
}

function closeAlertModal() {
  document.getElementById('snapshot-modal').style.display = 'none';
  activeAlert = null;
}

// Delete alert trigger from modal
async function deleteActiveAlert() {
  if (!activeAlert) return;
  const deleted = await deleteAlertItem(activeAlert.id, document.getElementById('btn-modal-delete'));
  if (deleted) closeAlertModal();
}

// Delete helper call
async function deleteAlertItem(id, trigger = null) {
  if (deletingAlertIds.has(id)) return false;
  deletingAlertIds.add(id);
  if (trigger) trigger.disabled = true;
  const status = document.getElementById('alerts-status');
  let deleted = false;
  try {
    const res = await fetch(VyntrixConfig.apiUrl(`/api/alerts/${id}`), {
      method: 'DELETE',
      credentials: 'include'
    });
    
    if (res.ok) {
      alertsCache = alertsCache.filter(a => a.id !== id);
      renderAlertList();
      console.log('Motion event deleted.');
      status.textContent = '';
      status.classList.remove('is-error');
      deleted = true;
    } else {
      throw new Error(`Delete request returned ${res.status}`);
    }
  } catch (err) {
    console.error('Failed to delete alert log:', err);
    status.textContent = 'This motion event could not be deleted. Try again.';
    status.classList.add('is-error');
  } finally {
    deletingAlertIds.delete(id);
    if (trigger?.isConnected) trigger.disabled = false;
  }
  return deleted;
}

// Initialise on load
document.addEventListener('DOMContentLoaded', init);
window.addEventListener('beforeunload', () => {
  remoteStageResizeObserver?.disconnect();
  if (peerConnection) {
    peerConnection.close();
  }
  micStream?.getTracks().forEach(track => track.stop());
});
