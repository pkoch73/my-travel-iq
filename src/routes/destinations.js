import { Hono } from 'hono';

const app = new Hono();

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function geocodeWithNominatim(location) {
  // Strip parenthetical IATA/airport codes like "(BOS)" or "(AMS)" to avoid confusing Nominatim
  const query = location.replace(/\s*\([A-Z]{2,4}\)\s*/g, ' ').trim();
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=1&addressdetails=0`;
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'MyTravelIQ/1.0 (https://my-travel-iq.philipp-koch.workers.dev)',
        'Accept-Language': 'en'
      }
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!Array.isArray(data) || data.length === 0) return null;
    return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
  } catch {
    return null;
  }
}

// GET /api/destinations
// Returns [{trip_id, trip_name, location, lat, lng}] — one entry per trip,
// pinned to the location where the most total time is spent (preferring 2+ day stays).
app.get('/', async (c) => {
  const user = c.get('user');
  const db = c.env.DB;

  // Sum time spent at each start_location per trip.
  // Segments without datetimes contribute 0 seconds but still appear (count fallback).
  const { results: rows } = await db.prepare(`
    SELECT
      s.trip_id,
      t.name AS trip_name,
      UPPER(TRIM(s.start_location)) AS location,
      SUM(
        CASE
          WHEN s.start_datetime IS NOT NULL AND s.end_datetime IS NOT NULL
          THEN (julianday(s.end_datetime) - julianday(s.start_datetime)) * 86400
          ELSE 0
        END
      ) AS total_seconds,
      COUNT(*) AS seg_count
    FROM segments s
    JOIN trip_members tm ON tm.trip_id = s.trip_id
    JOIN trips t ON t.id = s.trip_id
    WHERE tm.user_id = ? AND TRIM(s.start_location) != ''
    GROUP BY s.trip_id, UPPER(TRIM(s.start_location))
  `).bind(user.id).all();

  if (!rows || rows.length === 0) return c.json([]);

  // For each trip, pick the location with the most total_seconds.
  // Tie-break by seg_count (frequency).
  const tripBest = new Map(); // trip_id → {trip_name, location, total_seconds, seg_count}
  for (const row of rows) {
    const prev = tripBest.get(row.trip_id);
    if (!prev ||
        row.total_seconds > prev.total_seconds ||
        (row.total_seconds === prev.total_seconds && row.seg_count > prev.seg_count)) {
      tripBest.set(row.trip_id, row);
    }
  }

  const uniqueLocations = [...new Set([...tripBest.values()].map(r => r.location))];

  // Batch-check geocache
  const cacheResults = await db.batch(
    uniqueLocations.map(loc =>
      db.prepare('SELECT lat, lng FROM geocache WHERE location = ?').bind(loc)
    )
  );

  const cachedCoords = new Map();
  const uncachedLocations = [];
  for (let i = 0; i < uniqueLocations.length; i++) {
    const row = cacheResults[i].results?.[0] ?? null;
    if (row) {
      cachedCoords.set(uniqueLocations[i], { lat: row.lat, lng: row.lng });
    } else {
      uncachedLocations.push(uniqueLocations[i]);
    }
  }

  // Geocode uncached — max 15, 1.1s apart to respect Nominatim rate limit
  const newlyGeocoded = new Map();
  for (let i = 0; i < Math.min(uncachedLocations.length, 15); i++) {
    if (i > 0) await sleep(1100);
    const coords = await geocodeWithNominatim(uncachedLocations[i]);
    if (coords) newlyGeocoded.set(uncachedLocations[i], coords);
  }

  // Persist new geocodes
  if (newlyGeocoded.size > 0) {
    await db.batch(
      [...newlyGeocoded.entries()].map(([loc, coords]) =>
        db.prepare(
          `INSERT OR REPLACE INTO geocache (location, lat, lng, cached_at) VALUES (?, ?, ?, datetime('now'))`
        ).bind(loc, coords.lat, coords.lng)
      )
    );
  }

  // Assemble response — one entry per trip
  const allCoords = new Map([...cachedCoords, ...newlyGeocoded]);
  const destinations = [];
  for (const [tripId, row] of tripBest) {
    const coords = allCoords.get(row.location);
    if (!coords) continue;
    destinations.push({ trip_id: tripId, trip_name: row.trip_name, location: row.location, lat: coords.lat, lng: coords.lng });
  }

  return c.json(destinations);
});

export { app as destinationsRoutes };
