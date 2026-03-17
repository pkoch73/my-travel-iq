let tripId = getParam('tripId');
let extractedData = null;
let tripMembers = [];
let screenshotFile = null;

(async function() {
  if (!tripId) { window.location.href = '/'; return; }
  await ensureAuth();

  document.getElementById('backBtn').href = `/trip.html?id=${tripId}`;

  // Load trip members
  try {
    tripMembers = await api(`/trips/${tripId}/members`);
  } catch { tripMembers = []; }

  // Tab switching
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById(`tab-${tab.dataset.tab}`).classList.add('active');
    });
  });

  document.getElementById('extractTextBtn').addEventListener('click', extractText);
  document.getElementById('extractPdfBtn').addEventListener('click', extractPdfs);
  document.getElementById('confirmAllBtn').addEventListener('click', confirmAll);
  document.getElementById('discardBtn').addEventListener('click', discard);

  // Screenshot handlers
  const dropzone = document.getElementById('screenshotDropzone');
  const fileInput = document.getElementById('screenshotFile');

  dropzone.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', (e) => {
    if (e.target.files[0]) setScreenshot(e.target.files[0]);
  });

  // Drag and drop
  dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('dragover'); });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('dragover');
    const file = e.dataTransfer.files[0];
    if (file && file.type.startsWith('image/')) setScreenshot(file);
  });

  // Clipboard paste (only on screenshot tab)
  document.addEventListener('paste', (e) => {
    const activeTab = document.querySelector('.tab.active');
    if (!activeTab || activeTab.dataset.tab !== 'screenshot') return;
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        setScreenshot(item.getAsFile());
        return;
      }
    }
  });

  document.getElementById('clearScreenshotBtn').addEventListener('click', clearScreenshot);
  document.getElementById('extractScreenshotBtn').addEventListener('click', extractScreenshot);
})();

// ========================
// Screenshot (with review)
// ========================

function setScreenshot(file) {
  screenshotFile = file;
  const preview = document.getElementById('screenshotPreview');
  const img = document.getElementById('screenshotImg');
  const dropzone = document.getElementById('screenshotDropzone');

  img.src = URL.createObjectURL(file);
  preview.style.display = 'block';
  dropzone.style.display = 'none';
  document.getElementById('extractScreenshotBtn').disabled = false;
}

function clearScreenshot() {
  screenshotFile = null;
  const preview = document.getElementById('screenshotPreview');
  const img = document.getElementById('screenshotImg');
  const dropzone = document.getElementById('screenshotDropzone');

  if (img.src) URL.revokeObjectURL(img.src);
  img.src = '';
  preview.style.display = 'none';
  dropzone.style.display = 'flex';
  document.getElementById('extractScreenshotBtn').disabled = true;
  document.getElementById('screenshotFile').value = '';
}

async function extractScreenshot() {
  if (!screenshotFile) { toast('Please select a screenshot'); return; }

  showLoading('Analyzing screenshot...');
  try {
    const formData = new FormData();
    formData.append('file', screenshotFile);
    formData.append('trip_id', tripId);

    const token = getToken();
    const headers = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const res = await fetch('/api/extract/screenshot', {
      method: 'POST',
      headers,
      credentials: 'same-origin',
      body: formData
    });

    const data = await res.json();

    if (!res.ok) {
      hideLoading();
      showError(data.error || 'Screenshot extraction failed');
      return;
    }

    extractedData = data;
    showResults();
  } catch (e) {
    hideLoading();
    toast('Extraction failed: ' + e.message);
  }
}

// ========================
// Text Paste (with review)
// ========================

async function extractText() {
  const text = document.getElementById('bookingText').value.trim();
  if (!text) { toast('Please paste some booking text'); return; }

  showLoading();
  try {
    extractedData = await api('/extract/text', {
      method: 'POST',
      body: { trip_id: tripId, text }
    });
    showResults();
  } catch (e) {
    hideLoading();
    toast('Extraction failed: ' + e.message);
  }
}

// ========================
// PDF Upload (multi-file, auto-confirm)
// ========================

/**
 * Extract text from a PDF file using PDF.js (client-side).
 */
async function extractPdfText(file) {
  const arrayBuffer = await file.arrayBuffer();
  const pdfjsLib = window.pdfjsLib;
  if (!pdfjsLib) throw new Error('PDF.js library not loaded');

  pdfjsLib.GlobalWorkerOptions.workerSrc =
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const pages = [];

  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const pageText = content.items.map(item => item.str).join(' ');
    if (pageText.trim()) {
      pages.push(pageText);
    }
  }

  return pages.join('\n\n');
}

/**
 * Process multiple PDF files sequentially, auto-confirming each.
 */
async function extractPdfs() {
  const fileInput = document.getElementById('pdfFile');
  const files = Array.from(fileInput.files);
  if (!files.length) { toast('Please select one or more PDFs'); return; }

  const statusEl = document.getElementById('extractionStatus');
  statusEl.style.display = 'block';
  document.getElementById('extractionResults').style.display = 'none';

  const results = []; // { filename, status: 'ok'|'error', count, error }

  for (let fi = 0; fi < files.length; fi++) {
    const file = files[fi];
    const fileLabel = esc(file.name);

    // Render current progress
    renderPdfProgress(results, { name: file.name, step: 'Reading PDF...' }, files.length);

    // Step 1: Client-side text extraction
    let clientText = '';
    try {
      clientText = await extractPdfText(file);
    } catch (e) {
      console.warn(`Client-side PDF text extraction failed for ${file.name}:`, e);
    }

    renderPdfProgress(results, { name: file.name, step: 'Extracting booking details...' }, files.length);

    // Step 2: Upload to server for AI extraction
    let data;
    try {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('trip_id', tripId);
      if (clientText) {
        formData.append('extracted_text', clientText);
      }

      const token = getToken();
      const headers = {};
      if (token) headers['Authorization'] = `Bearer ${token}`;
      const res = await fetch('/api/extract/pdf', {
        method: 'POST',
        headers,
        credentials: 'same-origin',
        body: formData
      });

      data = await res.json();

      if (!res.ok) {
        results.push({ filename: file.name, status: 'error', count: 0, error: data.error || 'Upload failed' });
        continue;
      }
    } catch (e) {
      results.push({ filename: file.name, status: 'error', count: 0, error: e.message });
      continue;
    }

    // Check for extraction errors or empty results
    if (data.error) {
      results.push({ filename: file.name, status: 'error', count: 0, error: data.error });
      continue;
    }

    if (!data.segments || data.segments.length === 0) {
      results.push({ filename: file.name, status: 'error', count: 0, error: 'No bookings found' });
      continue;
    }

    // Step 3: Auto-confirm — save segments immediately
    renderPdfProgress(results, { name: file.name, step: `Saving ${data.segments.length} booking(s)...` }, files.length);

    try {
      const segments = data.segments.map(seg => ({
        type: seg.type,
        title: seg.title || '',
        start_datetime: seg.start_datetime || null,
        end_datetime: seg.end_datetime || null,
        timezone: seg.timezone || 'UTC',
        start_location: seg.start_location || '',
        end_location: seg.end_location || '',
        confirmation_number: seg.confirmation_number || '',
        provider: seg.provider || '',
        booking_reference: seg.booking_reference || '',
        details: seg.details || {},
        notes: seg.notes || '',
        traveler_ids: []
      }));

      await api('/extract/confirm', {
        method: 'POST',
        body: { trip_id: tripId, input_id: data.input_id, segments }
      });

      results.push({ filename: file.name, status: 'ok', count: data.segments.length });
    } catch (e) {
      results.push({ filename: file.name, status: 'error', count: 0, error: 'Save failed: ' + e.message });
    }
  }

  // Final summary
  renderPdfProgress(results, null, files.length);
}

/**
 * Render per-file progress into the status area.
 * @param {Array} results - Completed file results
 * @param {Object|null} current - Currently processing file { name, step } or null if done
 * @param {number} total - Total number of files
 */
function renderPdfProgress(results, current, total) {
  const statusEl = document.getElementById('extractionStatus');

  let html = '';

  // Completed files
  for (const r of results) {
    if (r.status === 'ok') {
      html += `<div class="pdf-progress-line pdf-ok">\u2713 ${esc(r.filename)} \u2014 ${r.count} booking(s) saved</div>`;
    } else {
      html += `<div class="pdf-progress-line pdf-err">\u2717 ${esc(r.filename)} \u2014 ${esc(r.error)}</div>`;
    }
  }

  // Current file
  if (current) {
    html += `<div class="pdf-progress-line pdf-current"><span class="spinner"></span> ${esc(current.name)} \u2014 ${esc(current.step)}</div>`;
  }

  // Summary when done
  if (!current && results.length > 0) {
    const okCount = results.filter(r => r.status === 'ok').reduce((sum, r) => sum + r.count, 0);
    const okFiles = results.filter(r => r.status === 'ok').length;
    const errFiles = results.filter(r => r.status === 'error').length;

    html += '<div style="margin-top:1rem;padding-top:0.75rem;border-top:1px solid var(--border)">';
    if (okCount > 0) {
      html += `<p style="font-weight:600;margin-bottom:0.5rem">${okCount} booking(s) saved from ${okFiles} file(s)</p>`;
    }
    if (errFiles > 0) {
      html += `<p style="font-size:0.85rem;color:var(--text-secondary);margin-bottom:0.75rem">${errFiles} file(s) had issues. Try the "Paste Text" tab for those.</p>`;
    }
    html += `<a class="btn btn-primary" href="/trip.html?id=${tripId}">Go to Trip</a>`;
    html += '</div>';
  }

  statusEl.innerHTML = `<div class="pdf-progress">${html}</div>`;
}

// ========================
// Text paste review UI
// ========================

function showLoading(msg) {
  const el = document.getElementById('extractionStatus');
  el.style.display = 'block';
  el.innerHTML = `<div class="loading"><span class="spinner"></span> ${msg || 'Extracting booking details with AI...'}</div>`;
  document.getElementById('extractionResults').style.display = 'none';
}

function hideLoading() {
  document.getElementById('extractionStatus').style.display = 'none';
}

function showError(message) {
  hideLoading();
  const results = document.getElementById('extractionResults');
  results.style.display = 'block';
  document.getElementById('resultCards').innerHTML = `
    <div class="extraction-error">
      <strong>Extraction Error</strong>
      <p>${esc(message)}</p>
      <p style="font-size:0.85rem;color:var(--text-secondary);margin-top:0.5rem">
        Tip: Try copying the booking text and pasting it in the "Paste Text" tab instead.
      </p>
    </div>`;
}

function confidenceBadge(confidence) {
  const colors = { high: '#22c55e', medium: '#eab308', low: '#ef4444' };
  const labels = { high: 'High confidence', medium: 'Medium confidence', low: 'Low confidence' };
  const color = colors[confidence] || colors.low;
  const label = labels[confidence] || labels.low;
  return `<span class="confidence-badge" style="background:${color}">${label}</span>`;
}

function showResults() {
  hideLoading();
  const results = document.getElementById('extractionResults');
  results.style.display = 'block';
  const container = document.getElementById('resultCards');

  if (extractedData.error) {
    showError(extractedData.error);
    return;
  }

  if (!extractedData.segments || extractedData.segments.length === 0) {
    container.innerHTML = `
      <div class="extraction-empty">
        <p><strong>No bookings detected</strong></p>
        <p style="font-size:0.85rem;color:var(--text-secondary)">
          The AI couldn't find booking information in the provided content.
          Try the "Paste Text" tab — copy the booking details from your email or confirmation page and paste them directly.
        </p>
      </div>`;
    return;
  }

  const badge = confidenceBadge(extractedData.confidence);
  container.innerHTML = `
    <div style="margin-bottom:0.75rem">${badge} — ${extractedData.segments.length} booking(s) found</div>
    ${extractedData.segments.map((seg, i) => renderExtractionCard(seg, i)).join('')}`;
}

function renderExtractionCard(seg, index) {
  const typeOptions = SEGMENT_TYPES.map(t =>
    `<option value="${t}" ${t === seg.type ? 'selected' : ''}>${segmentLabel(t)}</option>`
  ).join('');

  const memberChecks = tripMembers.map(m => `
    <label class="traveler-check">
      <input type="checkbox" name="members_${index}" value="${m.id}"
        ${(seg.traveler_names || []).some(n => n.toLowerCase().includes(m.name.toLowerCase().split(' ')[0])) ? 'checked' : ''}>
      ${m.picture_url
        ? `<div class="traveler-dot" style="background-image:url(${m.picture_url});background-size:cover;background-color:${m.color};width:16px;height:16px"></div>`
        : `<div class="traveler-dot" style="background:${m.color};width:16px;height:16px;font-size:0.5rem">${travelerInitial(m.name)}</div>`}
      ${esc(m.name)}
    </label>
  `).join('');

  return `
    <div class="extraction-card" data-index="${index}">
      <div class="extraction-card form-row">
        <div class="form-group">
          <label>Type</label>
          <select name="type_${index}">${typeOptions}</select>
        </div>
        <div class="form-group">
          <label>Title</label>
          <input type="text" name="title_${index}" value="${esc(seg.title || '')}">
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label>Start</label>
          <input type="datetime-local" name="start_${index}" value="${dtLocalVal(seg.start_datetime)}">
        </div>
        <div class="form-group">
          <label>End</label>
          <input type="datetime-local" name="end_${index}" value="${dtLocalVal(seg.end_datetime)}">
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label>From</label>
          <input type="text" name="start_loc_${index}" value="${esc(seg.start_location || '')}">
        </div>
        <div class="form-group">
          <label>To</label>
          <input type="text" name="end_loc_${index}" value="${esc(seg.end_location || '')}">
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label>Confirmation #</label>
          <input type="text" name="conf_${index}" value="${esc(seg.confirmation_number || '')}">
        </div>
        <div class="form-group">
          <label>Provider</label>
          <input type="text" name="provider_${index}" value="${esc(seg.provider || '')}">
        </div>
      </div>
      <div class="form-group">
        <label>Notes</label>
        <input type="text" name="notes_${index}" value="${esc(seg.notes || '')}">
      </div>
      <div class="form-group">
        <label>Members</label>
        <div class="traveler-checks">${memberChecks || '<span style="color:var(--text-secondary);font-size:0.85rem">No members yet</span>'}</div>
      </div>
    </div>`;
}

async function confirmAll() {
  if (!extractedData || !extractedData.segments.length) return;

  const segments = extractedData.segments.map((seg, i) => {
    const get = (name) => document.querySelector(`[name="${name}_${i}"]`)?.value || '';

    const memberIds = Array.from(
      document.querySelectorAll(`[name="members_${i}"]:checked`)
    ).map(cb => cb.value);

    return {
      type: get('type'),
      title: get('title'),
      start_datetime: isoFromLocal(get('start')) || null,
      end_datetime: isoFromLocal(get('end')) || null,
      timezone: seg.timezone || 'UTC',
      start_location: get('start_loc'),
      end_location: get('end_loc'),
      confirmation_number: get('conf'),
      provider: get('provider'),
      booking_reference: seg.booking_reference || '',
      details: seg.details || {},
      notes: get('notes'),
      member_ids: memberIds
    };
  });

  try {
    await api('/extract/confirm', {
      method: 'POST',
      body: { trip_id: tripId, input_id: extractedData.input_id, segments }
    });
    toast('Bookings saved!');
    window.location.href = `/trip.html?id=${tripId}`;
  } catch (e) {
    toast('Save failed: ' + e.message);
  }
}

function discard() {
  extractedData = null;
  document.getElementById('extractionResults').style.display = 'none';
  document.getElementById('extractionStatus').style.display = 'none';
  document.getElementById('bookingText').value = '';
  document.getElementById('pdfFile').value = '';
  clearScreenshot();
}
