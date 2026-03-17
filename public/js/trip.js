let tripData = null;
let tripMembers = [];
let editingSegment = null;
const tripId = getParam('id');

(async function() {
  if (!tripId) { window.location.href = '/'; return; }
  await ensureAuth();
  await loadTrip();

  document.getElementById('addFab').href = `/add.html?tripId=${tripId}`;
  document.getElementById('editTripBtn').addEventListener('click', openEditModal);
  document.getElementById('saveTripBtn').addEventListener('click', saveTrip);
  document.getElementById('deleteTripBtn').addEventListener('click', deleteTrip);
  document.getElementById('shareBtn').addEventListener('click', openShareModal);
  document.getElementById('membersBtn').addEventListener('click', openMembersModal);
  document.getElementById('cancelEditSegBtn').addEventListener('click', closeEditSegModal);
  document.getElementById('saveEditSegBtn').addEventListener('click', saveSegment);
})();

async function loadTrip() {
  tripData = await api(`/trips/${tripId}`);
  document.title = `${tripData.name} — My Travel IQ`;

  // Show delete button only for owner
  if (tripData.my_role === 'owner') {
    document.getElementById('deleteTripBtn').style.display = '';
  }

  // Load trip members
  try {
    tripMembers = await api(`/trips/${tripId}/members`);
  } catch { tripMembers = []; }

  document.getElementById('tripHeader').innerHTML = `
    <div class="trip-hero">
      <h2 class="trip-hero-name">${esc(tripData.name)}</h2>
      <div class="trip-hero-dates">${formatDateRange(tripData.start_date, tripData.end_date)}</div>
      ${tripData.description ? `<p class="trip-hero-desc">${esc(tripData.description)}</p>` : ''}
    </div>`;

  renderTimeline(tripData.segments);
}

function renderDayHeader(dk, isToday = false) {
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

function renderTimeline(segments) {
  const container = document.getElementById('timeline');

  if (segments.length === 0) {
    container.innerHTML = `
      <div class="empty">
        <p>No bookings yet. Add your first one!</p>
        <a href="/add.html?tripId=${tripId}" class="btn btn-primary">+ Add Booking</a>
      </div>`;
    return;
  }

  const byDate = {};
  const noDate = [];

  for (const seg of segments) {
    const dk = dateKey(seg.start_datetime);
    if (dk) {
      if (!byDate[dk]) byDate[dk] = [];
      byDate[dk].push(seg);
    } else {
      noDate.push(seg);
    }
  }

  // Inject end-event cards for multi-day bookings
  const endEvents = generateEndEvents(segments);
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

  let html = '<div class="timeline">';

  const todayKey = new Date().toISOString().slice(0, 10);
  let todayInserted = false;

  const sortedDates = Object.keys(byDate).sort();
  for (const dk of sortedDates) {
    // Insert divider before the first date that is in the future (today has no bookings)
    if (!todayInserted && dk > todayKey) {
      html += '<div class="today-marker">Today</div>';
      todayInserted = true;
    }
    const isToday = dk === todayKey;
    if (isToday) todayInserted = true;
    html += renderDayHeader(dk, isToday);
    for (const item of byDate[dk]) {
      html += item._isEndEvent ? renderEndCard(item) : renderSegmentCard(item);
    }
  }

  // Trip already ended — append today marker after all dates
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
      html += renderSegmentCard(seg);
    }
  }

  html += '</div>';
  container.innerHTML = html;

  // Attach handlers
  container.querySelectorAll('.conf-num').forEach(el => {
    el.addEventListener('click', () => copyToClipboard(el.dataset.conf));
  });
  container.querySelectorAll('.edit-seg').forEach(el => {
    el.addEventListener('click', () => {
      const seg = segments.find(s => s.id === el.dataset.id);
      if (seg) openEditSegModal(seg);
    });
  });
  container.querySelectorAll('.delete-seg').forEach(el => {
    el.addEventListener('click', async () => {
      if (!confirm('Delete this booking?')) return;
      await api(`/segments/${el.dataset.id}`, { method: 'DELETE' });
      toast('Deleted');
      await loadTrip();
    });
  });
}

function renderSegmentCard(seg) {
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
      seg.travelers.map(t => {
        if (t.picture_url) {
          return `<div class="traveler-dot" style="background-image:url(${t.picture_url});background-size:cover;background-color:${t.color}" title="${esc(t.name)}"></div>`;
        }
        return `<div class="traveler-dot" style="background:${t.color}" title="${esc(t.name)}">${travelerInitial(t.name)}</div>`;
      }).join('') + '</div>';
  }

  const typeColor = `var(--${seg.type || 'other'})`;

  return `
    <div class="segment-card" style="border-left-color:${typeColor}">
      <div class="segment-header">
        <span class="segment-icon">${segmentIcon(seg.type)}</span>
        <span class="segment-title">${esc(seg.title)}</span>
        ${timeRange ? `<span class="segment-time-badge">${timeRange}</span>` : ''}
        <div class="segment-actions">
          <button class="seg-action seg-action-edit edit-seg" data-id="${seg.id}" title="Edit">&#9998;</button>
          <button class="seg-action seg-action-delete delete-seg" data-id="${seg.id}" title="Delete">&times;</button>
        </div>
      </div>
      <div class="segment-details">
        ${detailParts.join(' &middot; ')}${confHtml}
        ${extraParts.length ? ' &middot; ' + extraParts.join(' &middot; ') : ''}
        ${seg.notes ? `<br><em>${esc(seg.notes)}</em>` : ''}
      </div>
      ${travelersHtml}
    </div>`;
}

function renderEndCard(ev) {
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

// ========================
// Edit Segment Modal
// ========================

function openEditSegModal(seg) {
  editingSegment = seg;

  const typeSelect = document.getElementById('editSegType');
  typeSelect.innerHTML = SEGMENT_TYPES.map(t =>
    `<option value="${t}" ${t === seg.type ? 'selected' : ''}>${segmentLabel(t)}</option>`
  ).join('');

  document.getElementById('editSegId').value = seg.id;
  document.getElementById('editSegTitle').value = seg.title || '';
  document.getElementById('editSegStart').value = dtLocalVal(seg.start_datetime);
  document.getElementById('editSegEnd').value = dtLocalVal(seg.end_datetime);
  document.getElementById('editSegStartLoc').value = seg.start_location || '';
  document.getElementById('editSegEndLoc').value = seg.end_location || '';
  document.getElementById('editSegConf').value = seg.confirmation_number || '';
  document.getElementById('editSegProvider').value = seg.provider || '';
  document.getElementById('editSegNotes').value = seg.notes || '';

  // Show trip members as checkboxes instead of travelers
  const segMemberIds = (seg.travelers || []).map(t => t.id);
  const memberContainer = document.getElementById('editSegMembers');
  if (tripMembers.length > 0) {
    memberContainer.innerHTML = tripMembers.map(m => `
      <label class="traveler-check">
        <input type="checkbox" name="editSegMember" value="${m.id}"
          ${segMemberIds.includes(m.id) ? 'checked' : ''}>
        ${m.picture_url
          ? `<div class="traveler-dot" style="background-image:url(${m.picture_url});background-size:cover;background-color:${m.color};width:16px;height:16px"></div>`
          : `<div class="traveler-dot" style="background:${m.color};width:16px;height:16px;font-size:0.5rem">${travelerInitial(m.name)}</div>`}
        ${esc(m.name)}
      </label>
    `).join('');
  } else {
    memberContainer.innerHTML = '<span style="color:var(--text-secondary);font-size:0.85rem">No members yet</span>';
  }

  document.getElementById('editSegModal').style.display = 'flex';
}

function closeEditSegModal() {
  document.getElementById('editSegModal').style.display = 'none';
  editingSegment = null;
}

async function saveSegment() {
  if (!editingSegment) return;
  const id = document.getElementById('editSegId').value;

  const memberIds = Array.from(
    document.querySelectorAll('[name="editSegMember"]:checked')
  ).map(cb => cb.value);

  const body = {
    type: document.getElementById('editSegType').value,
    title: document.getElementById('editSegTitle').value.trim(),
    start_datetime: isoFromLocal(document.getElementById('editSegStart').value) || null,
    end_datetime: isoFromLocal(document.getElementById('editSegEnd').value) || null,
    timezone: editingSegment.timezone || 'UTC',
    start_location: document.getElementById('editSegStartLoc').value.trim(),
    end_location: document.getElementById('editSegEndLoc').value.trim(),
    confirmation_number: document.getElementById('editSegConf').value.trim(),
    provider: document.getElementById('editSegProvider').value.trim(),
    booking_reference: editingSegment.booking_reference || '',
    details: editingSegment.details || {},
    notes: document.getElementById('editSegNotes').value.trim(),
    member_ids: memberIds
  };

  try {
    await api(`/segments/${id}`, { method: 'PUT', body });
    closeEditSegModal();
    toast('Booking updated');
    await loadTrip();
  } catch (e) {
    toast('Save failed: ' + e.message);
  }
}

// ========================
// Members Modal
// ========================

async function openMembersModal() {
  const modal = document.getElementById('membersModal');
  const content = document.getElementById('membersContent');
  modal.style.display = 'flex';

  const members = await api(`/trips/${tripId}/members`);
  tripMembers = members;
  const currentUser = getCurrentUser();
  const isOwner = tripData.my_role === 'owner';

  let html = '';
  for (const m of members) {
    const isMe = m.id === currentUser?.id;
    html += `
      <div style="display:flex;align-items:center;gap:0.5rem;padding:0.5rem 0;border-bottom:1px solid var(--border)">
        ${m.picture_url
          ? `<div class="traveler-dot" style="background-image:url(${m.picture_url});background-size:cover;background-color:${m.color}"></div>`
          : `<div class="traveler-dot" style="background:${m.color}">${travelerInitial(m.name)}</div>`}
        <span style="flex:1;font-weight:600">${esc(m.name)}</span>
        <span style="font-size:0.75rem;color:var(--text-secondary);font-weight:600">
          ${m.role === 'owner' ? 'Owner' : 'Member'}${isMe ? ' (you)' : ''}
        </span>
        ${isOwner && !isMe ? `<button class="btn-icon" onclick="removeMember('${m.id}')" title="Remove">&times;</button>` : ''}
      </div>`;
  }

  html += `<p style="margin-top:1rem;font-size:0.8rem;color:var(--text-secondary)">
    Share a link to invite members to this trip.
  </p>`;

  content.innerHTML = html;
}

async function removeMember(userId) {
  if (!confirm('Remove this member from the trip?')) return;
  await api(`/trips/${tripId}/members/${userId}`, { method: 'DELETE' });
  toast('Member removed');
  await openMembersModal();
  await loadTrip();
}

// ========================
// Trip Edit / Delete / Share
// ========================

function openEditModal() {
  document.getElementById('editTripName').value = tripData.name;
  document.getElementById('editTripDesc').value = tripData.description || '';
  document.getElementById('editTripModal').style.display = 'flex';
}

async function saveTrip() {
  const name = document.getElementById('editTripName').value.trim();
  if (!name) return;
  await api(`/trips/${tripId}`, {
    method: 'PUT',
    body: {
      name,
      description: document.getElementById('editTripDesc').value.trim(),
      start_date: tripData.start_date,
      end_date: tripData.end_date
    }
  });
  document.getElementById('editTripModal').style.display = 'none';
  toast('Trip updated');
  await loadTrip();
}

async function deleteTrip() {
  if (!confirm('Delete this entire trip and all its bookings?')) return;
  await api(`/trips/${tripId}`, { method: 'DELETE' });
  window.location.href = '/';
}

async function openShareModal() {
  const modal = document.getElementById('shareModal');
  const content = document.getElementById('shareContent');
  modal.style.display = 'flex';

  const shares = await api(`/shares/trip/${tripId}`);

  let html = '';
  if (shares.length > 0) {
    html += '<p style="margin-bottom:0.75rem;font-size:0.85rem;color:var(--text-secondary)">Active share links:</p>';
    for (const s of shares) {
      const url = `${window.location.origin}/share.html?token=${s.token}`;
      html += `<div style="display:flex;align-items:center;gap:0.5rem;margin-bottom:0.5rem">
        <input type="text" value="${url}" readonly style="flex:1;font-size:0.8rem" onclick="this.select()">
        <button class="btn btn-sm btn-secondary" onclick="copyToClipboard('${url}')">Copy</button>
        <button class="btn btn-sm btn-danger" onclick="revokeShare('${s.id}')">Revoke</button>
      </div>`;
    }
    html += '<hr style="margin:0.75rem 0;border-color:var(--border)">';
  }

  html += '<p style="margin-bottom:0.75rem;font-size:0.85rem;color:var(--text-secondary)">Share links let others view and join your trip.</p>';
  html += '<button class="btn btn-primary" id="createShareBtn">Generate New Share Link</button>';
  content.innerHTML = html;

  document.getElementById('createShareBtn').addEventListener('click', async () => {
    await api('/shares', { method: 'POST', body: { trip_id: tripId } });
    toast('Share link created');
    await openShareModal();
  });
}

async function revokeShare(id) {
  await api(`/shares/${id}`, { method: 'DELETE' });
  toast('Share link revoked');
  await openShareModal();
}
