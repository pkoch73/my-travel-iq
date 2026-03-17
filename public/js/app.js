// --- Auth ---
// Token is now set via HttpOnly cookie by the server (Google OAuth callback).
// For backward compat, we also check localStorage (legacy anonymous tokens).
function getToken() {
  return localStorage.getItem('tiq_token');
}

let _currentUser = null;

async function ensureAuth() {
  // Try cookie-based auth first (set by Google OAuth), then localStorage fallback
  const res = await fetch('/api/auth/me', {
    credentials: 'same-origin',
    headers: getToken() ? { 'Authorization': `Bearer ${getToken()}` } : {}
  });
  if (res.ok) {
    _currentUser = await res.json();
    return true;
  }
  // Not authenticated — redirect to login
  window.location.href = '/login.html';
  return false;
}

function getCurrentUser() {
  return _currentUser;
}

async function logout() {
  await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
  localStorage.removeItem('tiq_token');
  window.location.href = '/login.html';
}

// --- API helper ---
async function api(path, options = {}) {
  const token = getToken();
  const headers = { ...options.headers };
  // Send token via header for backward compat; cookie also sent automatically
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (options.body && typeof options.body === 'object' && !(options.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(options.body);
  }
  const res = await fetch(`/api${path}`, { ...options, headers, credentials: 'same-origin' });
  if (!res.ok) {
    if (res.status === 401) {
      window.location.href = '/login.html';
      return;
    }
    const err = await res.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(err.error || 'Request failed');
  }
  return res.json();
}

// --- Segment type helpers ---
const SEGMENT_ICONS = {
  flight: '\u2708\uFE0F',
  hotel: '\uD83C\uDFE8',
  car_rental: '\uD83D\uDE97',
  restaurant: '\uD83C\uDF7D\uFE0F',
  activity: '\uD83D\uDCCD',
  train: '\uD83D\uDE86',
  bus: '\uD83D\uDE8C',
  ferry: '\u26F4\uFE0F',
  other: '\u2B55'
};

const SEGMENT_LABELS = {
  flight: 'Flight',
  hotel: 'Hotel',
  car_rental: 'Car Rental',
  restaurant: 'Restaurant',
  activity: 'Activity',
  train: 'Train',
  bus: 'Bus',
  ferry: 'Ferry',
  other: 'Other'
};

function segmentIcon(type) {
  return SEGMENT_ICONS[type] || SEGMENT_ICONS.other;
}

function segmentLabel(type) {
  return SEGMENT_LABELS[type] || 'Other';
}

const END_EVENT_LABELS = {
  flight: 'Arrival',
  hotel: 'Checkout',
  car_rental: 'Car Return',
  restaurant: 'Ends',
  activity: 'Ends',
  train: 'Arrival',
  bus: 'Arrival',
  ferry: 'Arrival',
  other: 'Ends'
};

function endEventLabel(type) {
  return END_EVENT_LABELS[type] || 'Ends';
}

// --- Date formatting ---
// Parse ISO datetime strings without timezone conversion
function parseLocalParts(dateStr) {
  if (!dateStr) return null;
  // Handle "YYYY-MM-DD" or "YYYY-MM-DDTHH:mm:ss"
  const [datePart, timePart] = dateStr.split('T');
  const [y, m, d] = datePart.split('-').map(Number);
  if (timePart) {
    const [h, min] = timePart.split(':').map(Number);
    return { y, m, d, h, min };
  }
  return { y, m, d, h: null, min: null };
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WEEKDAYS_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_FULL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function formatDate(dateStr) {
  const p = parseLocalParts(dateStr);
  if (!p) return '';
  // Use UTC constructor to avoid timezone shifts
  const d = new Date(Date.UTC(p.y, p.m - 1, p.d));
  return `${WEEKDAYS[d.getUTCDay()]}, ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${p.y}`;
}

function formatTime(dateStr) {
  const p = parseLocalParts(dateStr);
  if (!p || p.h === null) return '';
  return `${String(p.h).padStart(2, '0')}:${String(p.min).padStart(2, '0')}`;
}

function formatDateRange(start, end) {
  if (!start && !end) return 'No dates set';
  if (!end || start === end) return formatDate(start);
  return `${formatDate(start)} — ${formatDate(end)}`;
}

function dateKey(dateStr) {
  if (!dateStr) return null;
  return dateStr.slice(0, 10); // YYYY-MM-DD
}

// --- Toast ---
function toast(message) {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2500);
}

// --- Clipboard ---
function copyToClipboard(text) {
  navigator.clipboard.writeText(text).then(() => toast('Copied!')).catch(() => {});
}

// --- Traveler initial ---
function travelerInitial(name) {
  return name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
}

// --- URL params ---
function getParam(name) {
  return new URLSearchParams(window.location.search).get(name);
}

// --- Shared utilities ---
const SEGMENT_TYPES = ['flight','hotel','car_rental','restaurant','activity','train','bus','ferry','other'];

function esc(str) {
  if (!str) return '';
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

function dtLocalVal(iso) {
  if (!iso) return '';
  return iso.slice(0, 16); // "YYYY-MM-DDTHH:mm"
}

function isoFromLocal(val) {
  if (!val) return null;
  return val.length === 16 ? val + ':00' : val;
}

// --- Day header helpers ---
function formatDayParts(dateStr) {
  const p = parseLocalParts(dateStr);
  if (!p) return null;
  const d = new Date(Date.UTC(p.y, p.m - 1, p.d));
  return {
    dayOfWeek: WEEKDAYS_FULL[d.getUTCDay()],
    dayOfWeekShort: WEEKDAYS[d.getUTCDay()],
    month: MONTHS[d.getUTCMonth()],
    monthFull: MONTHS_FULL[d.getUTCMonth()],
    date: d.getUTCDate(),
    year: p.y
  };
}

function daysBetween(startStr, endStr) {
  if (!startStr || !endStr) return null;
  const s = new Date(startStr);
  const e = new Date(endStr);
  const diff = Math.round((e - s) / 86400000);
  return diff > 0 ? diff : null;
}

// --- End-event helpers ---
function isMultiDay(startStr, endStr) {
  if (!startStr || !endStr) return false;
  return dateKey(startStr) !== dateKey(endStr);
}

function generateEndEvents(segments) {
  const endEvents = [];
  for (const seg of segments) {
    if (!seg.start_datetime || !seg.end_datetime) continue;
    if (!isMultiDay(seg.start_datetime, seg.end_datetime)) continue;
    endEvents.push({
      _isEndEvent: true,
      _sourceSegmentId: seg.id,
      type: seg.type,
      title: seg.title,
      end_datetime: seg.end_datetime,
      end_location: seg.end_location,
      provider: seg.provider,
      travelers: seg.travelers,
      confirmation_number: seg.confirmation_number
    });
  }
  return endEvents;
}

// --- Trip accent colors ---
const TRIP_COLORS = ['#22C55E', '#F59E0B', '#3B82F6', '#EF4444', '#8B5CF6', '#0EA5E9', '#EA580C', '#6366F1'];
