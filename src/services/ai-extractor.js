const SYSTEM_PROMPT = `You are a travel booking data extractor. You receive text from booking confirmations (emails, PDFs, receipts) in any language (English, German, French, Spanish, Italian, etc.).

Your job is to extract structured travel booking data and return it as JSON.

Rules:
1. Extract ALL bookings found in the text. One confirmation may contain multiple segments (e.g., outbound + return flight, multi-leg connections).
2. For flights: title should be "IATA_FROM → IATA_TO" (e.g., "ZRH → JFK"). Extract flight number, airline, seat if available.
   - Multi-leg flights with layovers: create a SEPARATE segment for each leg (e.g., BOS→AMS and AMS→OSL are 2 segments). Note the connection/layover in "notes".
   - Compact dates like "28Mar2026", "05Apr2026", "Sun, Mar 29" must be parsed into ISO format.
   - Put seat assignments, cabin class, terminal, gate, eTicket/ticket numbers, and baggage allowance in "details".
3. For hotels: title should be the hotel name. start_datetime = check-in, end_datetime = check-out. start_location = end_location = hotel address or city.
   - Put room type, number of nights, meal plan, check-in/check-out times in "details".
4. For car rentals: title = rental company + car class. start_location = pickup location, end_location = dropoff location.
   - Put car class, mileage limits, insurance type in "details".
5. For restaurants: title = restaurant name. start_datetime = reservation time.
   - Put party size, special requests, table preferences in "details".
6. For trains: title = "FROM → TO" with station names. Extract train number if available.
7. For activities/tours/guided trips: title = activity/tour name. type = "activity".
   - Put tour operator, duration, meeting point, guide info, group size in "details".
8. Dates must be in ISO 8601 format (YYYY-MM-DDTHH:mm:ss). If only a date is given without time, use T00:00:00. If year is ambiguous, assume the nearest future date from 2025 onwards.
9. Confirmation numbers: use the BOOKING CONFIRMATION or RESERVATION number (e.g., "Confirmation Number: JOHLA3" → "JOHLA3"). Do NOT use ticket numbers, eTicket numbers, or record locators as the confirmation number — those go in "details". The confirmation number is the short alphanumeric code used to look up the booking.
10. Traveler names: extract all passenger/guest names found.
11. Put type-specific details in the "details" object (seat number, room type, car class, flight number, meal plan, terminal, gate, etc.).
12. If a total price/cost is visible, include it in details as "total_price" with currency (e.g., "total_price": "USD 1234.56").
13. Set confidence to "high" if all key fields are clearly present, "medium" if some are inferred, "low" if the text is ambiguous or incomplete.

Return a JSON object with this exact structure:
{
  "segments": [
    {
      "type": "flight|hotel|car_rental|restaurant|activity|train|bus|ferry|other",
      "title": "short display title",
      "start_datetime": "ISO 8601 or null",
      "end_datetime": "ISO 8601 or null",
      "timezone": "timezone name e.g. Europe/Zurich",
      "start_location": "departure/pickup/checkin location",
      "end_location": "arrival/dropoff/checkout location",
      "confirmation_number": "booking reference",
      "provider": "airline/hotel chain/company name",
      "booking_reference": "any secondary reference",
      "traveler_names": ["Name 1", "Name 2"],
      "details": {},
      "notes": "any additional relevant info"
    }
  ],
  "confidence": "high|medium|low",
  "language_detected": "language code"
}`;

/**
 * Strip boilerplate text that wastes LLM tokens without adding booking info.
 * Works for any booking type: flights, hotels, car rentals, restaurants, tours.
 */
function preprocessText(text) {
  if (!text) return '';

  let t = text;

  // Remove common boilerplate section headers and everything after them
  const cutoffPatterns = [
    /\n\s*(?:TERMS?\s*(?:&|AND)\s*CONDITIONS?|TERMS\s*OF\s*(?:SERVICE|USE)).*/is,
    /\n\s*CONDITIONS?\s*OF\s*CARRIAGE.*/is,
  ];
  for (const pattern of cutoffPatterns) {
    t = t.replace(pattern, '\n');
  }

  // Remove specific boilerplate sections (bounded removal)
  const sectionPatterns = [
    // Legal / policy
    /(?:^|\n)\s*(?:PRIVACY\s*POLICY|COOKIE\s*POLICY|DATA\s*PROTECTION)[\s\S]*?(?=\n\s*[A-Z][a-z]|\n\s*$)/gi,
    /(?:^|\n)\s*(?:NON-?\s*REFUNDABLE|CHANGE\s*FEE|CANCELLATION\s*POLICY|PENALTY\s*(?:FEE|POLIC))[\s\S]*?(?=\n\s*[A-Z][a-z]|\n\s*$)/gi,
    /(?:^|\n)\s*(?:COPYRIGHT\s*(?:INFORMATION|\xA9|INFO)|ALL\s*RIGHTS\s*RESERVED)[\s\S]*?(?=\n\s*[A-Z][a-z]|\n\s*$)/gi,
    /(?:^|\n)\s*(?:KEY\s*OF\s*TERMS|LEGEND|GLOSSARY)[\s\S]*?(?=\n\s*[A-Z][a-z]|\n\s*$)/gi,
    /(?:^|\n)\s*(?:LIABILITY\s*DISCLAIMER|LIMITATION\s*OF\s*LIABILITY|INDEMNIFICATION)[\s\S]*?(?=\n\s*[A-Z][a-z]|\n\s*$)/gi,
    // Airline-specific boilerplate
    /(?:^|\n)\s*(?:BAGGAGE\s*(?:INFORMATION|POLIC|ALLOWANCE|CHARGES))[\s\S]*?(?=\n\s*[A-Z][a-z]|\n\s*$)/gi,
    /(?:^|\n)\s*(?:TRIP\s*PROTECTION|TRAVEL\s*INSURANCE|TRIP\s*INSURANCE)[\s\S]*?(?=\n\s*[A-Z][a-z]|\n\s*$)/gi,
    // Note: Do NOT strip SkyMiles/loyalty number lines — they often appear on the same line as confirmation numbers
    // Car rental fine print
    /(?:^|\n)\s*(?:RENTAL\s*AGREEMENT\s*TERMS|DAMAGE\s*WAIVER|INSURANCE\s*WAIVER|ADDITIONAL\s*DRIVER\s*POLIC)[\s\S]*?(?=\n\s*[A-Z][a-z]|\n\s*$)/gi,
  ];
  for (const pattern of sectionPatterns) {
    t = t.replace(pattern, '\n');
  }

  // Remove individual tax/fee line items but keep totals
  // Matches lines like "  US Transportation Tax  $12.34" or "Passenger Facility Charge: 4.50"
  t = t.replace(/^[ \t]*(?:\w[\w\s]*(?:tax|fee|charge|surcharge|levy))[ \t]*[:.]?[ \t]*\$?[\d,.]+[ \t]*$/gim, '');

  // Remove copyright lines
  t = t.replace(/^.*(?:\xA9|copyright)\s*\d{4}.*$/gim, '');

  // Collapse excessive whitespace (3+ newlines → 2)
  t = t.replace(/\n{3,}/g, '\n\n');
  // Collapse excessive spaces
  t = t.replace(/[ \t]{4,}/g, '  ');

  t = t.trim();

  // Hard truncate as safety net for token limits
  if (t.length > 8000) {
    t = t.slice(0, 8000);
  }

  return t;
}

function deduplicateSegments(segments) {
  const seen = new Set();
  return segments.filter(seg => {
    const key = `${seg.type}|${seg.title}|${seg.start_datetime}|${seg.confirmation_number}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const VISION_MODEL = '@cf/meta/llama-3.2-11b-vision-instruct';

/**
 * Extract text from an image using the Llama 3.2 Vision model.
 * Returns raw text description of what the model sees in the image.
 * Auto-agrees to Meta license on first use.
 */
export async function extractFromImage(ai, imageArrayBuffer) {
  const imageArray = [...new Uint8Array(imageArrayBuffer)];

  const prompt = 'Read ALL text in this image. Output every word, number, date, time, name, and code exactly as written. Be thorough.';

  const response = await ai.run(VISION_MODEL, {
    prompt,
    image: imageArray,
    max_tokens: 768
  });
  const text = response?.response || response?.description || '';
  return text.trim();
}

const TEXT_MODEL_DEFAULT = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
const TEXT_MODEL_FAST = '@cf/meta/llama-3.1-8b-instruct-fast';

/**
 * Extract structured booking data from text using an LLM.
 * @param {object} ai - Workers AI binding
 * @param {string} text - raw booking text
 * @param {object} [opts] - options
 * @param {boolean} [opts.fast] - use faster 8B model (for screenshot pipeline where vision already consumed time)
 */
export async function extractFromText(ai, text, opts = {}) {
  const preprocessed = preprocessText(text);

  if (!preprocessed) {
    return {
      segments: [],
      confidence: 'low',
      language_detected: 'unknown',
      raw_text: text,
      error: 'No usable text found after preprocessing'
    };
  }

  const model = opts.fast ? TEXT_MODEL_FAST : TEXT_MODEL_DEFAULT;

  const response = await ai.run(model, {
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: preprocessed }
    ],
    response_format: { type: 'json_object' },
    max_tokens: 2048
  });

  // The AI may return the result in different shapes depending on the model
  const rawResponse = typeof response === 'string' ? response :
                      response.response ? response.response :
                      JSON.stringify(response);

  try {
    const parsed = typeof rawResponse === 'object' ? rawResponse : JSON.parse(rawResponse);
    return {
      segments: deduplicateSegments(parsed.segments || []),
      confidence: parsed.confidence || 'low',
      language_detected: parsed.language_detected || 'unknown',
      raw_text: text
    };
  } catch {
    // Try to extract JSON from markdown code block if the model wrapped it
    const jsonMatch = rawResponse.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[1]);
        return {
          segments: deduplicateSegments(parsed.segments || []),
          confidence: parsed.confidence || 'low',
          language_detected: parsed.language_detected || 'unknown',
          raw_text: text
        };
      } catch {}
    }

    return {
      segments: [],
      confidence: 'low',
      language_detected: 'unknown',
      raw_text: text,
      error: 'Failed to parse AI response',
      debug_response: rawResponse.slice(0, 500)
    };
  }
}
