let recordings = [];
let activePlaybackId = null;
const deletingRecordingIds = new Set();

async function initializeRecordingsPage() {
  document.getElementById('btn-retry-recordings').addEventListener('click', loadRecordings);
  const session = await protectPage();
  if (!session?.loggedIn) {
    if (session?.unavailable) showRecordingsError('Vyntrix is currently unreachable. Check your connection and try again.');
    return;
  }
  await loadRecordings();
}

async function loadRecordings() {
  const list = document.getElementById('recordings-list');
  const retry = document.getElementById('btn-retry-recordings');
  list.setAttribute('aria-busy', 'true');
  retry.hidden = true;
  setRecordingsStatus('Loading your recordings…');
  renderStateCard('◌', 'Loading recordings', 'Connecting securely to your private archive.');

  try {
    const response = await fetch(VyntrixConfig.apiUrl('/api/recordings'), {
      credentials: 'include'
    });
    if (response.status === 401) {
      window.location.href = `/login.html?redirect=${encodeURIComponent('/recordings.html')}`;
      return;
    }
    if (!response.ok) throw new Error('Recordings request failed');
    const result = await response.json();
    recordings = Array.isArray(result.recordings) ? result.recordings : [];
    activePlaybackId = null;
    renderRecordings();
  } catch (error) {
    console.error('Could not load recordings:', error?.name || 'Error');
    showRecordingsError('Your recordings could not be loaded. Check your connection and try again.');
  } finally {
    list.setAttribute('aria-busy', 'false');
  }
}

function setRecordingsStatus(message, isError = false) {
  const status = document.getElementById('recordings-status');
  status.textContent = message;
  status.classList.toggle('is-error', isError);
}

function renderStateCard(icon, title, description) {
  const list = document.getElementById('recordings-list');
  const card = document.createElement('div');
  card.className = 'recordings-state-card';
  const iconElement = document.createElement('span');
  iconElement.className = 'recordings-state-icon';
  iconElement.setAttribute('aria-hidden', 'true');
  iconElement.textContent = icon;
  const heading = document.createElement('h2');
  heading.textContent = title;
  const text = document.createElement('p');
  text.textContent = description;
  card.append(iconElement, heading, text);
  list.replaceChildren(card);
}

function showRecordingsError(message) {
  recordings = [];
  document.getElementById('recordings-count').textContent = '—';
  document.getElementById('btn-retry-recordings').hidden = false;
  setRecordingsStatus(message, true);
  renderStateCard('!', 'Unable to load recordings', 'Your private archive was not changed.');
}

function renderRecordings() {
  const list = document.getElementById('recordings-list');
  document.getElementById('recordings-count').textContent = String(recordings.length);
  if (!recordings.length) {
    setRecordingsStatus('No recordings yet.');
    renderStateCard('▣', 'No recordings yet', 'Start a manual recording from the Camera Console to create your first clip.');
    return;
  }

  setRecordingsStatus(`${recordings.length} ${recordings.length === 1 ? 'recording' : 'recordings'} available.`);
  list.replaceChildren(...recordings.map(createRecordingCard));
}

function createRecordingCard(recording) {
  const card = document.createElement('article');
  card.className = 'recording-list-card';
  card.dataset.recordingId = recording.id;
  if (deletingRecordingIds.has(recording.id)) card.classList.add('is-deleting');

  const header = document.createElement('div');
  header.className = 'recording-list-header';
  const titleGroup = document.createElement('div');
  const title = document.createElement('h2');
  title.textContent = recording.cameraName || 'Camera';
  const date = document.createElement('time');
  date.dateTime = recording.startedAt || recording.createdAt || '';
  date.textContent = formatRecordingDate(recording.startedAt || recording.createdAt);
  titleGroup.append(title, date);
  const badge = document.createElement('span');
  badge.className = `recording-status-badge ${recording.status === 'uploaded' ? 'is-ready' : ''}`;
  badge.textContent = recording.status || 'unknown';
  header.append(titleGroup, badge);

  const details = document.createElement('dl');
  details.className = 'recording-details';
  appendDetail(details, 'Duration', formatDuration(recording.durationSeconds));
  appendDetail(details, 'File size', formatFileSize(recording.sizeBytes));
  appendDetail(details, 'Type', formatContentType(recording.contentType));

  const actions = document.createElement('div');
  actions.className = 'recording-actions-row';
  const playButton = document.createElement('button');
  playButton.type = 'button';
  playButton.className = 'btn btn-primary';
  playButton.textContent = activePlaybackId === recording.id ? 'Close Player' : 'Play';
  playButton.setAttribute('aria-expanded', String(activePlaybackId === recording.id));
  playButton.disabled = recording.status !== 'uploaded' || deletingRecordingIds.has(recording.id);
  playButton.addEventListener('click', () => togglePlayback(recording.id));
  const deleteButton = document.createElement('button');
  deleteButton.type = 'button';
  deleteButton.className = 'btn btn-danger';
  deleteButton.textContent = deletingRecordingIds.has(recording.id) ? 'Deleting…' : 'Delete';
  deleteButton.disabled = deletingRecordingIds.has(recording.id);
  deleteButton.addEventListener('click', () => deleteRecording(recording));
  actions.append(playButton, deleteButton);

  card.append(header, details, actions);
  if (activePlaybackId === recording.id) card.append(createRecordingPlayer(recording));
  return card;
}

function appendDetail(list, label, value) {
  const item = document.createElement('div');
  const term = document.createElement('dt');
  term.textContent = label;
  const description = document.createElement('dd');
  description.textContent = value;
  item.append(term, description);
  list.append(item);
}

function createRecordingPlayer(recording) {
  const region = document.createElement('div');
  region.className = 'recording-player';
  const video = document.createElement('video');
  video.controls = true;
  video.playsInline = true;
  video.preload = 'metadata';
  video.crossOrigin = 'use-credentials';
  video.setAttribute('aria-label', `${recording.cameraName || 'Camera'} recording playback`);
  video.src = VyntrixConfig.apiUrl(`/api/recordings/${encodeURIComponent(recording.id)}/content`);
  const feedback = document.createElement('p');
  feedback.className = 'recording-player-feedback';
  feedback.setAttribute('role', 'status');
  video.addEventListener('error', () => {
    feedback.textContent = 'This recording could not be played. Try again in a moment.';
  });
  region.append(video, feedback);
  return region;
}

function togglePlayback(recordingId) {
  activePlaybackId = activePlaybackId === recordingId ? null : recordingId;
  renderRecordings();
  if (activePlaybackId) {
    const activeCard = document.querySelector(`[data-recording-id="${CSS.escape(activePlaybackId)}"]`);
    activeCard?.querySelector('video')?.play().catch(() => {});
  }
}

async function deleteRecording(recording) {
  if (deletingRecordingIds.has(recording.id)) return;
  const confirmed = window.confirm(`Delete the recording from ${recording.cameraName || 'this camera'}? This cannot be undone.`);
  if (!confirmed) return;

  deletingRecordingIds.add(recording.id);
  if (activePlaybackId === recording.id) activePlaybackId = null;
  renderRecordings();
  setRecordingsStatus('Deleting recording…');

  try {
    const response = await fetch(VyntrixConfig.apiUrl(`/api/recordings/${encodeURIComponent(recording.id)}`), {
      method: 'DELETE',
      credentials: 'include'
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.success) throw new Error('Delete request failed');
    recordings = recordings.filter(item => item.id !== recording.id);
    deletingRecordingIds.delete(recording.id);
    renderRecordings();
  } catch (error) {
    console.error('Could not delete recording:', error?.name || 'Error');
    deletingRecordingIds.delete(recording.id);
    renderRecordings();
    setRecordingsStatus('The recording could not be deleted. Please try again.', true);
  }
}

function formatRecordingDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Unknown date';
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short'
  }).format(date);
}

function formatDuration(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) return 'Unknown';
  const rounded = Math.round(seconds);
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const remainder = rounded % 60;
  return hours
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`
    : `${minutes}:${String(remainder).padStart(2, '0')}`;
}

function formatFileSize(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return 'Unknown';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let amount = bytes / 1024;
  let unitIndex = 0;
  while (amount >= 1024 && unitIndex < units.length - 1) {
    amount /= 1024;
    unitIndex += 1;
  }
  return `${amount >= 10 ? amount.toFixed(1) : amount.toFixed(2)} ${units[unitIndex]}`;
}

function formatContentType(value) {
  if (value === 'video/webm') return 'WebM video';
  if (value === 'video/mp4') return 'MP4 video';
  return value || 'Unknown';
}

document.addEventListener('DOMContentLoaded', initializeRecordingsPage);
