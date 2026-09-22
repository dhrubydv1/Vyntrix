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
let remoteFrameOrientation = null;
let remoteOrientationProbe = null;
let remoteOrientationProbeTimer = null;
let remoteOrientationLayoutFrame = null;
let remoteStageResizeObserver = null;

const MONITOR_MIRROR_STORAGE_KEY = 'vyntrix.monitor.mirrorView';
const VALID_FACING_MODES = new Set(['user', 'environment']);

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

  videoEl.addEventListener('loadedmetadata', refreshRemoteVideoOrientation);
  videoEl.addEventListener('resize', refreshRemoteVideoOrientation);
  videoEl.addEventListener('webkitbeginfullscreen', updateFullscreenControls);
  videoEl.addEventListener('webkitendfullscreen', updateFullscreenControls);
  document.addEventListener('fullscreenchange', updateFullscreenControls);
  document.addEventListener('webkitfullscreenchange', updateFullscreenControls);
  window.addEventListener('orientationchange', refreshRemoteVideoOrientation);
  if (screen.orientation?.addEventListener) {
    screen.orientation.addEventListener('change', refreshRemoteVideoOrientation);
  }
  const remoteStage = document.getElementById('remote-video-stage');
  if ('ResizeObserver' in window && remoteStage) {
    remoteStageResizeObserver = new ResizeObserver(scheduleRemoteOrientationBoundsUpdate);
    remoteStageResizeObserver.observe(remoteStage);
  }
  configureFullscreenControl();

  mirrorToggle.addEventListener('change', (event) => {
    const mirrored = event.target.checked;
    writePreference(MONITOR_MIRROR_STORAGE_KEY, String(mirrored));
    applyRemoteMirror(mirrored);
  });

  document.querySelectorAll('[data-facing-mode]').forEach((button) => {
    button.addEventListener('click', () => requestRemoteCameraSwitch(button.dataset.facingMode));
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

  // Siren toggle control
  const sirenCheckbox = document.getElementById('control-siren');
  sirenCheckbox.addEventListener('change', (e) => {
    if (!activeCameraSocketId) return;
    const action = e.target.checked ? 'start' : 'stop';
    socket.emit('trigger-siren', {
      targetSocketId: activeCameraSocketId,
      action
    });
  });

  // Push to Talk (Walkie-Talkie) microphone trigger
  const pttButton = document.getElementById('btn-ptt');
  
  // Pointer and keyboard controls keep hold-to-talk usable without duplicate
  // mouse/touch events on hybrid devices.
  const startTalking = (e) => {
    e.preventDefault();
    if (!micTrack) {
      console.warn('Microphone track is not active or authorized.');
      return;
    }
    pttButton.classList.add('active');
    micTrack.enabled = true; // Unmute mic track
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

function normalizedRotation(rotation) {
  if (!Number.isFinite(rotation)) return 0;
  return ((Math.round(rotation / 90) * 90) % 360 + 360) % 360;
}

function requiredRemoteRotation(videoEl) {
  if (!remoteFrameOrientation) return 0;
  const { rotation, rawWidth, rawHeight, displayWidth, displayHeight } = remoteFrameOrientation;
  if (rotation !== 90 && rotation !== 270) return 0;

  const renderedOrientation = dimensionOrientation(videoEl.videoWidth, videoEl.videoHeight);
  const rawOrientation = dimensionOrientation(rawWidth, rawHeight);
  const displayOrientation = dimensionOrientation(displayWidth, displayHeight);

  // VideoFrame display dimensions include its rotation. If the media element
  // already matches them, the browser has handled orientation and another CSS
  // rotation would turn an upright feed sideways. Correct only when the element
  // still matches the unrotated frame dimensions.
  if (renderedOrientation === displayOrientation) return 0;
  if (renderedOrientation === rawOrientation && rawOrientation !== displayOrientation) {
    return rotation;
  }
  return 0;
}

function updateRemoteVideoLayout() {
  const videoEl = document.getElementById('remote-video');
  const stage = document.getElementById('remote-video-stage');
  const wrapper = document.getElementById('video-wrapper');
  if (!videoEl || !stage || !wrapper || !videoEl.videoWidth || !videoEl.videoHeight) return;

  const rotation = requiredRemoteRotation(videoEl);
  const needsQuarterTurn = rotation === 90 || rotation === 270;
  const width = needsQuarterTurn ? videoEl.videoHeight : videoEl.videoWidth;
  const height = needsQuarterTurn ? videoEl.videoWidth : videoEl.videoHeight;
  const orientation = dimensionOrientation(width, height);
  stage.classList.remove('is-portrait', 'is-landscape', 'is-square');
  stage.classList.add(`is-${orientation}`);
  stage.style.setProperty('--remote-video-aspect-ratio', `${width} / ${height}`);
  stage.dataset.videoOrientation = orientation;
  wrapper.classList.toggle('is-remote-orientation-corrected', needsQuarterTurn);
  if (needsQuarterTurn) {
    wrapper.style.setProperty('--remote-video-rotation', `${rotation}deg`);
    stage.dataset.orientationCorrection = String(rotation);
  } else {
    wrapper.style.removeProperty('--remote-video-rotation');
    delete stage.dataset.orientationCorrection;
  }
  scheduleRemoteOrientationBoundsUpdate();
}

function scheduleRemoteOrientationBoundsUpdate() {
  if (remoteOrientationLayoutFrame !== null) {
    cancelAnimationFrame(remoteOrientationLayoutFrame);
  }
  remoteOrientationLayoutFrame = requestAnimationFrame(() => {
    remoteOrientationLayoutFrame = null;
    const stage = document.getElementById('remote-video-stage');
    const wrapper = document.getElementById('video-wrapper');
    if (!stage || !wrapper || !wrapper.classList.contains('is-remote-orientation-corrected')) return;
    wrapper.style.setProperty('--remote-oriented-width', `${stage.clientHeight}px`);
    wrapper.style.setProperty('--remote-oriented-height', `${stage.clientWidth}px`);
  });
}

function cancelRemoteOrientationProbe() {
  if (remoteOrientationProbeTimer) {
    clearTimeout(remoteOrientationProbeTimer);
    remoteOrientationProbeTimer = null;
  }
  if (!remoteOrientationProbe) return;
  const { reader, track } = remoteOrientationProbe;
  remoteOrientationProbe = null;
  reader?.cancel().catch(() => {});
  track?.stop();
}

async function inspectRemoteFrameOrientation() {
  const videoEl = document.getElementById('remote-video');
  const sourceTrack = videoEl?.srcObject?.getVideoTracks?.()[0];
  if (!sourceTrack || sourceTrack.readyState !== 'live' || !('MediaStreamTrackProcessor' in window)) return;

  cancelRemoteOrientationProbe();
  const probeTrack = sourceTrack.clone();
  let reader = null;
  let frame = null;
  let timeoutId = null;
  try {
    const processor = new MediaStreamTrackProcessor({ track: probeTrack, maxBufferSize: 1 });
    reader = processor.readable.getReader();
    const probe = { reader, track: probeTrack };
    remoteOrientationProbe = probe;
    const result = await Promise.race([
      reader.read(),
      new Promise((resolve) => {
        timeoutId = setTimeout(() => resolve(null), 1500);
      })
    ]);
    if (remoteOrientationProbe !== probe || !result?.value) return;

    frame = result.value;
    const rotation = normalizedRotation(frame.rotation);
    const visibleRect = frame.visibleRect;
    remoteFrameOrientation = {
      rotation,
      rawWidth: visibleRect?.width || frame.codedWidth,
      rawHeight: visibleRect?.height || frame.codedHeight,
      displayWidth: frame.displayWidth,
      displayHeight: frame.displayHeight
    };
    updateRemoteVideoLayout();
  } catch (error) {
    // Frame metadata inspection is progressive enhancement. Browsers without a
    // main-thread processor continue using their native WebRTC orientation.
    console.debug('Remote frame orientation metadata is unavailable:', error?.name || 'Error');
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    frame?.close();
    if (remoteOrientationProbe?.track === probeTrack) remoteOrientationProbe = null;
    reader?.cancel().catch(() => {});
    probeTrack.stop();
  }
}

function scheduleRemoteOrientationInspection(delay = 100) {
  if (remoteOrientationProbeTimer) clearTimeout(remoteOrientationProbeTimer);
  remoteOrientationProbeTimer = setTimeout(() => {
    remoteOrientationProbeTimer = null;
    inspectRemoteFrameOrientation();
  }, delay);
}

function refreshRemoteVideoOrientation(event) {
  if (event?.type === 'loadedmetadata' || event?.type === 'resize') {
    remoteFrameOrientation = null;
  }
  updateRemoteVideoLayout();
  scheduleRemoteOrientationInspection();
}

function resetRemoteVideoLayout() {
  const stage = document.getElementById('remote-video-stage');
  const wrapper = document.getElementById('video-wrapper');
  cancelRemoteOrientationProbe();
  remoteFrameOrientation = null;
  if (remoteOrientationLayoutFrame !== null) {
    cancelAnimationFrame(remoteOrientationLayoutFrame);
    remoteOrientationLayoutFrame = null;
  }
  if (stage) {
    stage.classList.remove('is-portrait', 'is-landscape', 'is-square');
    stage.style.removeProperty('--remote-video-aspect-ratio');
    delete stage.dataset.videoOrientation;
    delete stage.dataset.orientationCorrection;
  }
  if (wrapper) {
    wrapper.classList.remove('is-remote-orientation-corrected');
    wrapper.style.removeProperty('--remote-video-rotation');
    wrapper.style.removeProperty('--remote-oriented-width');
    wrapper.style.removeProperty('--remote-oriented-height');
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
  const stage = document.getElementById('remote-video-stage');
  const videoEl = document.getElementById('remote-video');
  const supported = Boolean(
    stage?.requestFullscreen
    || stage?.webkitRequestFullscreen
    || videoEl?.webkitEnterFullscreen
  );
  button.disabled = !supported;
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

function updateRemoteFacingControls(facingMode = null, disabled = false) {
  document.querySelectorAll('[data-facing-mode]').forEach((button) => {
    button.setAttribute('aria-pressed', String(button.dataset.facingMode === facingMode));
    button.disabled = disabled;
  });
}

function showRemoteCameraSwitchStatus(message = '', isError = false) {
  const status = document.getElementById('remote-camera-switch-status');
  if (!status) return;
  status.textContent = message;
  status.classList.toggle('is-error', isError);
}

function requestRemoteCameraSwitch(facingMode) {
  if (!VALID_FACING_MODES.has(facingMode) || remoteCameraSwitchInProgress) return;
  if (!socket?.connected || !activeCameraSocketId) {
    showRemoteCameraSwitchStatus('Connect to a camera before switching.', true);
    return;
  }

  remoteCameraSwitchInProgress = true;
  updateRemoteFacingControls(null, true);
  showRemoteCameraSwitchStatus(`Requesting ${facingMode === 'user' ? 'front' : 'back'} camera…`);
  socket.timeout(12000).emit('camera:switch', {
    targetSocketId: activeCameraSocketId,
    facingMode
  }, (timeoutError, result) => {
    remoteCameraSwitchInProgress = false;
    const response = timeoutError ? null : result;
    if (response?.success) {
      updateRemoteFacingControls(response.facingMode || facingMode);
      showRemoteCameraSwitchStatus(response.message || 'Camera switched.');
      remoteFrameOrientation = null;
      updateRemoteVideoLayout();
      scheduleRemoteOrientationInspection(250);
      return;
    }
    updateRemoteFacingControls(response?.facingMode || null);
    showRemoteCameraSwitchStatus(response?.message || 'Camera could not be switched. Try again.', true);
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
    reconnectToSelectedCamera();
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

  // Siren alert status sync
  socket.on('trigger-siren', ({ action }) => {
    const sirenCheckbox = document.getElementById('control-siren');
    if (sirenCheckbox) {
      sirenCheckbox.checked = (action === 'start');
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
    // If active camera went offline, return to list view
    if (activeCameraSocketId) {
      cleanupPeerConnection();
      activeCameraSocketId = null;
      document.getElementById('monitor-portal-view').style.display = 'none';
      document.getElementById('camera-selection-view').style.display = 'block';
      updateMonitorStatus('disconnected');
    }
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
}

function cleanupPeerConnection() {
  monitorConnectionAttempt += 1;
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
    pttButton.disabled = false;
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
    pttButton.disabled = !micTrack;
    pttButton.title = micTrack ? '' : 'Microphone is unavailable';
  } catch (err) {
    console.warn('Microphone permission denied. Walkie-Talkie feature disabled:', err);
    pttButton.title = 'Allow microphone access to use Talk';
  }
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
  updateMonitorStatus(isReconnect ? 'reconnecting' : 'connecting');

  // Swap view states
  document.getElementById('camera-selection-view').style.display = 'none';
  document.getElementById('monitor-portal-view').style.display = 'grid';
  document.getElementById('active-camera-title').innerText = name;

  // Reset controls UI
  document.getElementById('control-zoom').value = 1;
  document.getElementById('zoom-val').innerText = '1x';
  document.getElementById('control-nightvision').checked = false;
  document.getElementById('control-siren').checked = false;
  updateRemoteFacingControls();
  showRemoteCameraSwitchStatus();
  
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
      remoteFrameOrientation = null;
      refreshRemoteVideoOrientation();
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
  updateRemoteFacingControls();
  showRemoteCameraSwitchStatus();

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
      console.log(`Alert log ID ${id} deleted.`);
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
  cancelRemoteOrientationProbe();
  remoteStageResizeObserver?.disconnect();
  if (peerConnection) {
    peerConnection.close();
  }
  micStream?.getTracks().forEach(track => track.stop());
});
