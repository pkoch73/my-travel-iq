let _map = null;

(async function() {
  await ensureAuth();
  setupUserMenu();
  await Promise.all([loadTrips(), initMap()]);

  document.getElementById('createTripBtn').addEventListener('click', createTrip);
})();

async function initMap() {
  let destinations;
  try {
    destinations = await api('/destinations');
  } catch {
    return;
  }
  if (!destinations || destinations.length === 0) return;

  const section = document.getElementById('map-section');
  section.style.display = 'block';

  _map = L.map('trip-map', { scrollWheelZoom: false });

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    maxZoom: 19
  }).addTo(_map);

  const pinIcon = L.divIcon({
    className: '',
    html: `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="36" viewBox="0 0 28 36">
      <path d="M14 0C6.268 0 0 6.268 0 14c0 9.625 14 22 14 22S28 23.625 28 14C28 6.268 21.732 0 14 0z" fill="#22C55E"/>
      <circle cx="14" cy="14" r="6" fill="white"/>
    </svg>`,
    iconSize: [28, 36],
    iconAnchor: [14, 36],
    popupAnchor: [0, -36]
  });

  const markers = [];
  for (const dest of destinations) {
    const popup = `<div class="map-popup-location">${esc(dest.location)}</div><a class="map-popup-trip-link" href="/trip.html?id=${dest.trip_id}">${esc(dest.trip_name)}</a>`;
    const marker = L.marker([dest.lat, dest.lng], { icon: pinIcon })
      .bindPopup(popup)
      .addTo(_map);
    markers.push(marker);
  }

  if (markers.length === 1) {
    _map.setView([destinations[0].lat, destinations[0].lng], 8);
  } else {
    const group = L.featureGroup(markers);
    _map.fitBounds(group.getBounds().pad(0.15));
  }
}

function setupUserMenu() {
  const user = getCurrentUser();
  if (!user) return;

  const avatarBtn = document.getElementById('userAvatarBtn');
  const dropdown = document.getElementById('userDropdown');
  const info = document.getElementById('userDropdownInfo');

  // Set avatar
  if (user.picture_url) {
    avatarBtn.style.backgroundImage = `url(${user.picture_url})`;
    avatarBtn.style.backgroundSize = 'cover';
    avatarBtn.textContent = '';
  } else {
    avatarBtn.textContent = travelerInitial(user.name || user.email || '?');
    avatarBtn.style.background = user.color || 'var(--primary)';
  }

  // Set dropdown info
  info.innerHTML = `
    <div style="font-weight:700">${esc(user.name || 'User')}</div>
    ${user.email ? `<div style="font-size:0.8rem;color:var(--text-secondary)">${esc(user.email)}</div>` : ''}
  `;

  // Toggle dropdown
  avatarBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    dropdown.classList.toggle('show');
  });
  document.addEventListener('click', () => dropdown.classList.remove('show'));

  // Logout
  document.getElementById('logoutBtn').addEventListener('click', logout);
}

async function loadTrips() {
  const trips = await api('/trips');
  const container = document.getElementById('app');

  if (trips.length === 0) {
    container.innerHTML = `
      <div class="empty">
        <p>No trips yet. Create your first one!</p>
        <button class="btn btn-primary" onclick="document.getElementById('newTripModal').style.display='flex'">+ New Trip</button>
      </div>`;
    return;
  }

  let html = '<div class="dashboard-header">';
  html += '<h2 class="page-title">Your Trips</h2>';
  html += '<button class="btn btn-primary" onclick="document.getElementById(\'newTripModal\').style.display=\'flex\'">+ New Trip</button>';
  html += '</div>';

  for (let i = 0; i < trips.length; i++) {
    const trip = trips[i];
    const color = TRIP_COLORS[i % TRIP_COLORS.length];
    const days = daysBetween(trip.start_date, trip.end_date);
    const daysStr = days ? ` <span class="trip-card-duration">&middot; ${days} day${days !== 1 ? 's' : ''}</span>` : '';

    html += `
      <a href="/trip.html?id=${trip.id}" class="card-link">
        <div class="trip-card" style="border-left-color: ${color}">
          <div class="trip-card-body">
            <h3 class="trip-card-name">${esc(trip.name)}</h3>
            <div class="trip-card-dates">${formatDateRange(trip.start_date, trip.end_date)}${daysStr}</div>
            ${trip.description ? `<div class="trip-card-desc">${esc(trip.description)}</div>` : ''}
          </div>
          <div class="trip-card-right">
            <span class="trip-card-count">${trip.segment_count}</span>
            <span class="trip-card-count-label">booking${trip.segment_count !== 1 ? 's' : ''}</span>
          </div>
        </div>
      </a>`;
  }

  container.innerHTML = html;
}

async function createTrip() {
  const name = document.getElementById('newTripName').value.trim();
  if (!name) return;
  const desc = document.getElementById('newTripDesc').value.trim();

  await api('/trips', { method: 'POST', body: { name, description: desc } });
  document.getElementById('newTripModal').style.display = 'none';
  document.getElementById('newTripName').value = '';
  document.getElementById('newTripDesc').value = '';
  toast('Trip created!');
  await loadTrips();
}
