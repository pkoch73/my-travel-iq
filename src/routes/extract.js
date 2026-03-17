import { Hono } from 'hono';
import { extractFromText, extractFromImage } from '../services/ai-extractor.js';
import { uploadAndConvertPdf } from '../services/pdf-processor.js';

const app = new Hono();

// Extract from pasted text
app.post('/text', async (c) => {
  const user = c.get('user');
  const { trip_id, text } = await c.req.json();

  if (!trip_id || !text) {
    return c.json({ error: 'trip_id and text are required' }, 400);
  }

  // Verify trip membership
  const membership = await c.env.DB.prepare(
    'SELECT role FROM trip_members WHERE trip_id = ? AND user_id = ?'
  ).bind(trip_id, user.id).first();
  if (!membership) return c.json({ error: 'Trip not found' }, 404);

  const inputId = crypto.randomUUID();

  try {
    // Extract with AI
    const extraction = await extractFromText(c.env.AI, text);

    // Save raw input
    await c.env.DB.prepare(
      `INSERT INTO raw_inputs (id, trip_id, user_id, input_type, raw_text, extracted_json, status)
       VALUES (?, ?, ?, 'text', ?, ?, 'completed')`
    ).bind(inputId, trip_id, user.id, text, JSON.stringify(extraction)).run();

    return c.json({ input_id: inputId, ...extraction });
  } catch (err) {
    // Save failed input for tracking
    await c.env.DB.prepare(
      `INSERT INTO raw_inputs (id, trip_id, user_id, input_type, raw_text, extracted_json, status)
       VALUES (?, ?, ?, 'text', ?, ?, 'failed')`
    ).bind(inputId, trip_id, user.id, text, JSON.stringify({ error: err.message })).run();

    return c.json({ input_id: inputId, error: `Extraction failed: ${err.message}` }, 500);
  }
});

// Extract from PDF upload
app.post('/pdf', async (c) => {
  const user = c.get('user');
  const formData = await c.req.formData();
  const file = formData.get('file');
  const tripId = formData.get('trip_id');

  if (!tripId || !file) {
    return c.json({ error: 'trip_id and file are required' }, 400);
  }

  // Verify trip membership
  const membership = await c.env.DB.prepare(
    'SELECT role FROM trip_members WHERE trip_id = ? AND user_id = ?'
  ).bind(tripId, user.id).first();
  if (!membership) return c.json({ error: 'Trip not found' }, 404);

  const inputId = crypto.randomUUID();

  // Check if client sent pre-extracted text (from PDF.js)
  const clientExtractedText = formData.get('extracted_text') || '';

  // Upload to R2 and attempt server-side conversion
  let pdfResult;
  try {
    pdfResult = await uploadAndConvertPdf(c.env, file, user.id, inputId);
  } catch (err) {
    // R2 upload may have failed entirely
    if (!clientExtractedText) {
      await c.env.DB.prepare(
        `INSERT INTO raw_inputs (id, trip_id, user_id, input_type, original_filename, raw_text, extracted_json, status)
         VALUES (?, ?, ?, 'pdf', ?, '', ?, 'failed')`
      ).bind(inputId, tripId, user.id, file.name, JSON.stringify({ error: err.message })).run();

      return c.json({ input_id: inputId, error: `PDF upload failed: ${err.message}` }, 500);
    }
    // If client text is available, continue with it
    pdfResult = { r2Key: '', markdownText: '', error: err.message };
  }

  // Determine best text source: prefer client-extracted text (PDF.js) over server toMarkdown
  // because toMarkdown often returns empty for Chrome-printed or Apache FOP PDFs
  const textForExtraction = clientExtractedText.trim() || pdfResult.markdownText || '';

  if (!textForExtraction) {
    const errorMsg = pdfResult.error || 'Could not extract any text from the PDF. Try copying and pasting the booking text instead.';
    await c.env.DB.prepare(
      `INSERT INTO raw_inputs (id, trip_id, user_id, input_type, original_filename, r2_key, raw_text, extracted_json, status)
       VALUES (?, ?, ?, 'pdf', ?, ?, '', ?, 'failed')`
    ).bind(inputId, tripId, user.id, file.name, pdfResult.r2Key || '', JSON.stringify({ error: errorMsg })).run();

    return c.json({ input_id: inputId, error: errorMsg }, 422);
  }

  // Extract with AI
  try {
    const extraction = await extractFromText(c.env.AI, textForExtraction);

    // Save raw input
    await c.env.DB.prepare(
      `INSERT INTO raw_inputs (id, trip_id, user_id, input_type, original_filename, r2_key, raw_text, extracted_json, status)
       VALUES (?, ?, ?, 'pdf', ?, ?, ?, ?, 'completed')`
    ).bind(inputId, tripId, user.id, file.name, pdfResult.r2Key || '', textForExtraction, JSON.stringify(extraction)).run();

    return c.json({ input_id: inputId, ...extraction });
  } catch (err) {
    await c.env.DB.prepare(
      `INSERT INTO raw_inputs (id, trip_id, user_id, input_type, original_filename, r2_key, raw_text, extracted_json, status)
       VALUES (?, ?, ?, 'pdf', ?, ?, ?, ?, 'failed')`
    ).bind(inputId, tripId, user.id, file.name, pdfResult.r2Key || '', textForExtraction, JSON.stringify({ error: err.message })).run();

    return c.json({ input_id: inputId, error: `AI extraction failed: ${err.message}` }, 500);
  }
});

// Extract from screenshot image
app.post('/screenshot', async (c) => {
  const user = c.get('user');
  const formData = await c.req.formData();
  const file = formData.get('file');
  const tripId = formData.get('trip_id');

  if (!tripId || !file) {
    return c.json({ error: 'trip_id and file are required' }, 400);
  }

  // Verify trip membership
  const membership = await c.env.DB.prepare(
    'SELECT role FROM trip_members WHERE trip_id = ? AND user_id = ?'
  ).bind(tripId, user.id).first();
  if (!membership) return c.json({ error: 'Trip not found' }, 404);

  const inputId = crypto.randomUUID();

  // Read the file buffer ONCE (stream may only be readable once in Workers)
  const filename = file.name || 'screenshot.png';
  const r2Key = `uploads/${user.id}/${inputId}/${filename}`;
  let arrayBuffer;
  try {
    arrayBuffer = await file.arrayBuffer();
  } catch (err) {
    return c.json({ input_id: inputId, error: `Failed to read file: ${err.message}` }, 400);
  }

  // Upload image to R2
  try {
    await c.env.R2.put(r2Key, arrayBuffer, {
      httpMetadata: { contentType: file.type || 'image/png' }
    });
  } catch (err) {
    await c.env.DB.prepare(
      `INSERT INTO raw_inputs (id, trip_id, user_id, input_type, original_filename, raw_text, extracted_json, status)
       VALUES (?, ?, ?, 'screenshot', ?, '', ?, 'failed')`
    ).bind(inputId, tripId, user.id, filename, JSON.stringify({ error: err.message })).run();
    return c.json({ input_id: inputId, error: `Upload failed: ${err.message}` }, 500);
  }

  // Step 1: Vision model reads the screenshot (reuse same arrayBuffer)
  let imageText = '';
  try {
    imageText = await extractFromImage(c.env.AI, arrayBuffer);
  } catch (err) {
    await c.env.DB.prepare(
      `INSERT INTO raw_inputs (id, trip_id, user_id, input_type, original_filename, r2_key, raw_text, extracted_json, status)
       VALUES (?, ?, ?, 'screenshot', ?, ?, '', ?, 'failed')`
    ).bind(inputId, tripId, user.id, filename, r2Key, JSON.stringify({ error: `Vision model failed: ${err.message}` })).run();
    return c.json({ input_id: inputId, error: `Screenshot analysis failed: ${err.message}` }, 500);
  }

  if (!imageText) {
    await c.env.DB.prepare(
      `INSERT INTO raw_inputs (id, trip_id, user_id, input_type, original_filename, r2_key, raw_text, extracted_json, status)
       VALUES (?, ?, ?, 'screenshot', ?, ?, '', ?, 'failed')`
    ).bind(inputId, tripId, user.id, filename, r2Key, JSON.stringify({ error: 'No text extracted from screenshot' })).run();
    return c.json({ input_id: inputId, error: 'Could not read any text from the screenshot. Try a clearer image or paste the text directly.' }, 422);
  }

  // Step 2: LLM extracts structured booking data from the text
  try {
    // Use fast model for Step 2 since vision model already consumed significant time
    const extraction = await extractFromText(c.env.AI, imageText, { fast: true });

    await c.env.DB.prepare(
      `INSERT INTO raw_inputs (id, trip_id, user_id, input_type, original_filename, r2_key, raw_text, extracted_json, status)
       VALUES (?, ?, ?, 'screenshot', ?, ?, ?, ?, 'completed')`
    ).bind(inputId, tripId, user.id, filename, r2Key, imageText, JSON.stringify(extraction)).run();

    return c.json({ input_id: inputId, ...extraction });
  } catch (err) {
    await c.env.DB.prepare(
      `INSERT INTO raw_inputs (id, trip_id, user_id, input_type, original_filename, r2_key, raw_text, extracted_json, status)
       VALUES (?, ?, ?, 'screenshot', ?, ?, ?, ?, 'failed')`
    ).bind(inputId, tripId, user.id, filename, r2Key, imageText, JSON.stringify({ error: err.message })).run();
    return c.json({ input_id: inputId, error: `AI extraction failed: ${err.message}` }, 500);
  }
});

// Confirm extracted segments and save them
app.post('/confirm', async (c) => {
  const user = c.get('user');
  const { trip_id, input_id, segments } = await c.req.json();

  if (!trip_id || !segments || !segments.length) {
    return c.json({ error: 'trip_id and segments are required' }, 400);
  }

  // Verify trip membership
  const membership = await c.env.DB.prepare(
    'SELECT role FROM trip_members WHERE trip_id = ? AND user_id = ?'
  ).bind(trip_id, user.id).first();
  if (!membership) return c.json({ error: 'Trip not found' }, 404);

  const createdIds = [];

  for (const seg of segments) {
    const id = crypto.randomUUID();
    await c.env.DB.prepare(
      `INSERT INTO segments (id, trip_id, type, title, start_datetime, end_datetime, timezone,
       start_location, end_location, confirmation_number, provider, booking_reference,
       details, notes, raw_input_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      id, trip_id, seg.type, seg.title || '',
      seg.start_datetime || null, seg.end_datetime || null, seg.timezone || 'UTC',
      seg.start_location || '', seg.end_location || '',
      seg.confirmation_number || '', seg.provider || '', seg.booking_reference || '',
      JSON.stringify(seg.details || {}), seg.notes || '',
      input_id || null
    ).run();

    // Assign travelers if provided
    if (seg.traveler_ids && seg.traveler_ids.length > 0) {
      const stmt = c.env.DB.prepare(
        'INSERT INTO segment_travelers (segment_id, traveler_id) VALUES (?, ?)'
      );
      await c.env.DB.batch(seg.traveler_ids.map(tid => stmt.bind(id, tid)));
    }

    createdIds.push(id);
  }

  // Auto-update trip date range
  const range = await c.env.DB.prepare(
    `SELECT MIN(date(start_datetime)) as min_date, MAX(date(COALESCE(end_datetime, start_datetime))) as max_date
     FROM segments WHERE trip_id = ? AND start_datetime IS NOT NULL`
  ).bind(trip_id).first();
  if (range && range.min_date) {
    await c.env.DB.prepare(
      `UPDATE trips SET start_date = ?, end_date = ?, updated_at = datetime('now') WHERE id = ?`
    ).bind(range.min_date, range.max_date, trip_id).run();
  }

  return c.json({ created: createdIds });
});

export { app as extractRoutes };
