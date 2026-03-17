let shareToken = null;
let sharedTripId = null;

(async function() {
  shareToken = getParam('token');
  if (!shareToken) {
    document.getElementById('app').innerHTML = '<div class="empty"><p>Invalid share link.</p></div>';
    return;
  }

  try {
    const res = await fetch(`/api/shared/${shareToken}`);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      document.getElementById('app').innerHTML = `<div class="empty"><p>${err.error || 'Share link not found or expired.'}</p></div>`;
      return;
    }

    const trip = await res.json();
    sharedTripId = trip.id;
    document.title = `${trip.name} — Shared Trip`;
    renderSharedTrip(trip);
  } catch {
    document.getElementById('app').innerHTML = '<div class="empty"><p>Failed to load shared trip.</p></div>';
  }
})();

function renderDayHeaderShared(dk, isToday = false) {
  const parts = formatDayParts(dk);
  if (!parts) {
    return `<div class="day-header"><div class="day-badge"><span class="day-badge-num">?</span></div><div class="day-label">Unknown date</div></div>`;
  }
  return `
    <div class="day-header">
      <div class="day-badge${isToday ? ' today' : ''}">
        <span class="day-badge-num">${parts.date}</span>
        <span class="day-badge-month">${parts.month}</span>
      </div>
      <div class="day-label">${parts.dayOfWeek}, ${parts.monthFull} ${parts.date}</div>
    </div>`;
}

function renderSharedTrip(trip) {
  const container = document.getElementById('app');

  // Check if user is logged in — auto-join if so, show sign-in link if not
  checkLoggedIn().then(async (loggedIn) => {
    if (loggedIn && sharedTripId) {
      // Auto-join the trip immediately
      const joinBanner = document.getElementById('joinBanner');
      if (joinBanner) {
        joinBanner.innerHTML = `<span style="font-size:0.85rem;color:var(--text-secondary)">Joining trip…</span>`;
      }
      try {
        const token = localStorage.getItem('tiq_token');
        const res = await fetch(`/api/trips/${sharedTripId}/members/join`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { 'Authorization': `Bearer ${token}` } : {})
          },
          body: JSON.stringify({ share_token: shareToken })
        });
        if (res.ok) {
          window.location.href = `/trip.html?id=${sharedTripId}`;
          return;
        }
      } catch {}
      // If join failed, still show the page (read-only)
      if (joinBanner) joinBanner.innerHTML = '';
    } else if (!loggedIn && sharedTripId) {
      const joinBanner = document.getElementById('joinBanner');
      if (joinBanner) {
        const returnTo = encodeURIComponent(`/share.html?token=${shareToken}`);
        joinBanner.innerHTML = `
          <a href="/login.html?return_to=${returnTo}" class="btn btn-secondary btn-sm">Sign in</a>
          <span style="font-size:0.85rem;color:var(--text-secondary);margin-left:0.5rem">to join and collaborate on this trip</span>`;
      }
    }
  });

  let html = `
    <div class="share-banner">Shared by ${esc(trip.shared_by)}</div>
    <div id="joinBanner" style="padding:0.5rem 0;display:flex;align-items:center"></div>
    <div class="trip-hero">
      <h2 class="trip-hero-name">${esc(trip.name)}</h2>
      <div class="trip-hero-dates">${formatDateRange(trip.start_date, trip.end_date)}</div>
      ${trip.description ? `<p class="trip-hero-desc">${esc(trip.description)}</p>` : ''}
    </div>`;

  if (!trip.segments || trip.segments.length === 0) {
    html += '<div class="empty"><p>No bookings in this trip yet.</p></div>';
    container.innerHTML = html;
    return;
  }

  const byDate = {};
  const noDate = [];

  for (const seg of trip.segments) {
    const dk = dateKey(seg.start_datetime);
    if (dk) {
      if (!byDate[dk]) byDate[dk] = [];
      byDate[dk].push(seg);
    } else {
      noDate.push(seg);
    }
  }

  // Inject end-event cards for multi-day bookings
  const endEvents = generateEndEvents(trip.segments);
  for (const ev of endEvents) {
    const dk = dateKey(ev.end_datetime);
    if (dk) {
      if (!byDate[dk]) byDate[dk] = [];
      byDate[dk].push(ev);
    }
  }

  // Sort items within each day chronologically
  for (const dk of Object.keys(byDate)) {
    byDate[dk].sort((a, b) => {
      const timeA = a._isEndEvent ? a.end_datetime : (a.start_datetime || '');
      const timeB = b._isEndEvent ? b.end_datetime : (b.start_datetime || '');
      return timeA.localeCompare(timeB);
    });
  }

  html += '<div class="timeline">';
  const todayKey = new Date().toISOString().slice(0, 10);
  let todayInserted = false;

  const sortedDates = Object.keys(byDate).sort();
  for (const dk of sortedDates) {
    if (!todayInserted && dk > todayKey) {
      html += '<div class="today-marker">Today</div>';
      todayInserted = true;
    }
    const isToday = dk === todayKey;
    if (isToday) todayInserted = true;
    html += renderDayHeaderShared(dk, isToday);
    for (const item of byDate[dk]) {
      html += item._isEndEvent ? renderEndCardShared(item) : renderCard(item);
    }
  }
  if (!todayInserted) {
    html += '<div class="today-marker">Today</div>';
  }
  if (noDate.length > 0) {
    html += `<div class="day-header">
      <div class="day-badge" style="background:var(--other)">
        <span class="day-badge-num" style="font-size:1rem">—</span>
      </div>
      <div class="day-label">Unscheduled</div>
    </div>`;
    for (const seg of noDate) {
      html += renderCard(seg);
    }
  }
  html += '</div>';
  container.innerHTML = html;

  container.querySelectorAll('.conf-num').forEach(el => {
    el.addEventListener('click', () => copyToClipboard(el.dataset.conf));
  });
}

function renderCard(seg) {
  const timeStr = seg.start_datetime ? formatTime(seg.start_datetime) : '';
  const endTimeStr = seg.end_datetime ? formatTime(seg.end_datetime) : '';
  const timeRange = timeStr && endTimeStr ? `${timeStr} — ${endTimeStr}` :
                    timeStr ? timeStr : '';

  let detailParts = [];
  if (seg.provider) detailParts.push(esc(seg.provider));
  if (seg.start_location && seg.end_location && seg.start_location !== seg.end_location) {
    detailParts.push(`${esc(seg.start_location)} &rarr; ${esc(seg.end_location)}`);
  } else if (seg.start_location) {
    detailParts.push(esc(seg.start_location));
  }

  let confHtml = '';
  if (seg.confirmation_number) {
    confHtml = ` <span class="conf-num" data-conf="${esc(seg.confirmation_number)}" title="Click to copy">${esc(seg.confirmation_number)}</span>`;
  }

  const details = seg.details || {};
  let extraParts = [];
  if (details.flight_number) extraParts.push(details.flight_number);
  if (details.seat) extraParts.push(`Seat ${details.seat}`);
  if (details.room_type) extraParts.push(details.room_type);
  if (details.car_class) extraParts.push(details.car_class);

  let travelersHtml = '';
  if (seg.travelers && seg.travelers.length > 0) {
    travelersHtml = '<div class="traveler-dots">' +
      seg.travelers.map(t =>
        `<div class="traveler-dot" style="background:${t.color}" title="${esc(t.name)}">${travelerInitial(t.name)}</div>`
      ).join('') + '</div>';
  }

  const typeColor = `var(--${seg.type || 'other'})`;

  return `
    <div class="segment-card" style="border-left-color:${typeColor}">
      <div class="segment-header">
        <span class="segment-icon">${segmentIcon(seg.type)}</span>
        <span class="segment-title">${esc(seg.title)}</span>
        ${timeRange ? `<span class="segment-time-badge">${timeRange}</span>` : ''}
      </div>
      <div class="segment-details">
        ${detailParts.join(' &middot; ')}${confHtml}
        ${extraParts.length ? ' &middot; ' + extraParts.join(' &middot; ') : ''}
        ${seg.notes ? `<br><em>${esc(seg.notes)}</em>` : ''}
      </div>
      ${travelersHtml}
    </div>`;
}

function renderEndCardShared(ev) {
  const endTime = formatTime(ev.end_datetime);
  const label = endEventLabel(ev.type);
  const typeColor = `var(--${ev.type || 'other'})`;

  let locationHtml = '';
  if (ev.end_location) {
    locationHtml = `<div class="segment-details"><span class="end-card-location">${esc(ev.end_location)}</span></div>`;
  }

  let travelersHtml = '';
  if (ev.travelers && ev.travelers.length > 0) {
    travelersHtml = '<div class="traveler-dots">' +
      ev.travelers.map(t =>
        `<div class="traveler-dot" style="background:${t.color}" title="${esc(t.name)}">${travelerInitial(t.name)}</div>`
      ).join('') + '</div>';
  }

  return `
    <div class="segment-card end-card" style="border-left-color:${typeColor}">
      <div class="segment-header">
        <span class="segment-icon">${segmentIcon(ev.type)}</span>
        <span class="segment-title end-card-title">${label} — ${esc(ev.title)}</span>
        ${endTime ? `<span class="segment-time-badge">${endTime}</span>` : ''}
      </div>
      ${locationHtml}
      ${travelersHtml}
    </div>`;
}

async function checkLoggedIn() {
  try {
    const token = localStorage.getItem('tiq_token');
    const res = await fetch('/api/auth/me', {
      credentials: 'same-origin',
      headers: token ? { 'Authorization': `Bearer ${token}` } : {}
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function joinTrip() {
  if (!sharedTripId || !shareToken) return;
  try {
    const token = localStorage.getItem('tiq_token');
    const res = await fetch(`/api/trips/${sharedTripId}/members/join`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { 'Authorization': `Bearer ${token}` } : {})
      },
      body: JSON.stringify({ share_token: shareToken })
    });
    if (res.ok) {
      window.location.href = `/trip.html?id=${sharedTripId}`;
    } else {
      const err = await res.json().catch(() => ({}));
      toast(err.error || 'Failed to join trip');
    }
  } catch {
    toast('Failed to join trip');
  }
}
