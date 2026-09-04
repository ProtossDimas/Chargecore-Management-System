// ============================================================
// NEXUS/OPS — Cloudflare Pages Functions API
// Backend: Google Sheets (via Service Account) as the database
// Frontend: index.html calls these /api/* endpoints
// ============================================================
//
// REQUIRED environment variables (set in Cloudflare Pages > Settings > Environment variables):
//
//   GOOGLE_SERVICE_ACCOUNT_EMAIL   e.g. nexus-ops@your-project.iam.gserviceaccount.com
//   GOOGLE_PRIVATE_KEY             full PEM private key from the service account JSON
//                                   (paste with real \n line breaks converted to literal
//                                    "\n" — this file handles both, see normalizePrivateKey)
//   GOOGLE_SHEET_ID                the spreadsheet ID from its URL
//   GOOGLE_MAPS_API_KEY            your Google Maps API key. Used for the frontend map,
//                                   AND server-side as a fallback to resolve share links
//                                   (see gmaps_link notes below) — make sure "Geocoding API"
//                                   is enabled for this key in Google Cloud Console, not
//                                   just "Maps JavaScript API".
//
// SPREADSHEET STRUCTURE — create one Google Sheet with these tabs (exact header row):
//
//   Assets        | asset_id | asset_name | asset_type | manufacturer | model | serial_number
//                 | location_id | location_name | city | latitude | longitude | gmaps_link
//                 | installation_date | status | last_maintenance
//
//   Locations     | location_id | location_name | location_type | city | latitude | longitude | gmaps_link
//
//   NOTE ON gmaps_link -> latitude/longitude:
//   `latitude`/`longitude` are OPTIONAL to fill by hand — you can leave them blank and
//   only fill `gmaps_link` (any Google Maps share link, including short maps.app.goo.gl
//   links) when entering rows directly in the Sheet. The server resolves coordinates
//   from the link automatically in two places:
//     1. On every POST/PUT from the web form (resolveGmapsLinkInPlace).
//     2. On every GET, for any row that still has an empty latitude/longitude but a
//        gmaps_link (backfillCoordsFromLinks) — it resolves the link, returns the
//        coordinates immediately for the map, and writes them back into the Sheet so
//        it only has to resolve that row once.
//   Resolution itself has two tiers (resolveGmapsLink):
//     a. Read coordinates straight out of the URL / redirect chain (fast, no API call).
//        Short links are expanded by following HTTP `Location` headers one hop at a
//        time — never by scraping page HTML, which is unreliable and can pick up an
//        unrelated coordinate from the page.
//     b. If that doesn't turn up coordinates but does turn up a place NAME (e.g.
//        ".../maps/place/Blok+M+Square/..."), that name is looked up via Google's
//        official Geocoding API using GOOGLE_MAPS_API_KEY. This needs "Geocoding API"
//        enabled for that key in Google Cloud Console.
//   If both tiers fail, the link is left unresolved (latitude/longitude untouched) rather
//   than guessing — a missing pin is preferable to a wrong one.
//   latitude/longitude columns should stay in the header row (don't delete the columns),
//   just leave the cells empty for rows entered manually with only a link.
//
//   WorkOrders    | wo_id | asset_id | type | technician | status | due_date
//
//   Incidents     | incident_id | asset_id | description | severity | status | reported_at
//
//   Inventory     | sku | item_name | warehouse | stock | min_stock | status
//
//   Shipments     | shipment_id | route | carrier | status | eta | pod
//
// Share the Sheet with the service account email as Editor.
//
// ============================================================

const SHEETS = {
  assets: "Assets",
  locations: "Locations",
  workorders: "WorkOrders",
  incidents: "Incidents",
  inventory: "Inventory",
  shipments: "Shipments",
};

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const path = url.pathname;

  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
  if (request.method === "OPTIONS") return new Response(null, { headers: cors });

  try {
    // Public, non-secret config for the frontend (Maps key is domain-restricted, safe to expose)
    if (path === "/api/config") {
      return json({ mapsApiKey: env.GOOGLE_MAPS_API_KEY || "" }, cors);
    }

    // Lets the frontend preview a pasted Google Maps link -> {lat, lng} before saving,
    // e.g. so it can drop a pin on the form. POST { link: "..." }
    if (path === "/api/resolve-gmaps-link" && request.method === "POST") {
      const body = await request.json();
      const coords = await resolveGmapsLink(body.link || body.gmaps_link || "", env);
      return json(coords || { error: "Tidak bisa membaca koordinat dari link ini" }, cors, coords ? 200 : 422);
    }

    if (path === "/api/dashboard") {
      const [assets, incidents, shipments, inventory] = await Promise.all([
        readSheet(env, SHEETS.assets),
        readSheet(env, SHEETS.incidents),
        readSheet(env, SHEETS.shipments),
        readSheet(env, SHEETS.inventory),
      ]);
      return json({ assets, incidents, shipments, inventory }, cors);
    }

    // /api/assets, /api/locations, /api/workorders, /api/incidents, /api/inventory, /api/shipments
    const match = path.match(/^\/api\/(assets|locations|workorders|incidents|inventory|shipments)$/);
    if (match) {
      const key = match[1];
      const sheetName = SHEETS[key];

      if (request.method === "GET") {
        const rows = await readSheet(env, sheetName);
        if (key === "assets" || key === "locations") {
          await backfillCoordsFromLinks(env, sheetName, rows, key === "assets" ? "asset_id" : "location_id");
        }
        return json(rows, cors);
      }

      if (request.method === "POST") {
        const body = await request.json();
        await resolveGmapsLinkInPlace(body, env);
        await appendRow(env, sheetName, body);
        return json({ ok: true }, cors);
      }

      if (request.method === "PUT") {
        const body = await request.json();
        await resolveGmapsLinkInPlace(body, env);
        const idField = Object.keys(body)[0]; // first field = id column, e.g. asset_id
        await updateRow(env, sheetName, idField, body);
        return json({ ok: true }, cors);
      }
    }

    return json({ error: "Not found", path }, cors, 404);
  } catch (err) {
    return json({ error: String(err && err.message ? err.message : err) }, cors, 500);
  }
}

function json(data, cors, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...cors },
  });
}

// ------------------------------------------------------------
// Google Sheets access via Service Account (JWT -> OAuth2 token)
// ------------------------------------------------------------

let cachedToken = null; // { token, expiresAt } — reused across requests within the same isolate

async function getAccessToken(env) {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 30000) {
    return cachedToken.token;
  }

  const email = env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const privateKey = normalizePrivateKey(env.GOOGLE_PRIVATE_KEY);
  if (!email || !privateKey) {
    throw new Error("Missing GOOGLE_SERVICE_ACCOUNT_EMAIL or GOOGLE_PRIVATE_KEY env var");
  }

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claims = {
    iss: email,
    scope: "https://www.googleapis.com/auth/spreadsheets",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  };

  const encoder = new TextEncoder();
  const b64url = (obj) =>
    btoa(JSON.stringify(obj)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

  const unsigned = `${b64url(header)}.${b64url(claims)}`;
  const key = await importPrivateKey(privateKey);
  const signature = await crypto.subtle.sign(
    { name: "RSASSA-PKCS1-v1_5" },
    key,
    encoder.encode(unsigned)
  );
  const sigB64 = arrayBufferToBase64Url(signature);
  const jwt = `${unsigned}.${sigB64}`;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=${encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer")}&assertion=${jwt}`,
  });

  const data = await res.json();
  if (!data.access_token) {
    throw new Error("Google auth failed: " + JSON.stringify(data));
  }

  cachedToken = { token: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  return data.access_token;
}

function normalizePrivateKey(raw) {
  if (!raw) return raw;
  return raw.includes("\\n") ? raw.replace(/\\n/g, "\n") : raw;
}

async function importPrivateKey(pem) {
  const pemBody = pem
    .replace("-----BEGIN PRIVATE KEY-----", "")
    .replace("-----END PRIVATE KEY-----", "")
    .replace(/\s+/g, "");
  const binary = atob(pemBody);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

  return crypto.subtle.importKey(
    "pkcs8",
    bytes.buffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
}

function arrayBufferToBase64Url(buf) {
  let binary = "";
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Handles rows that were entered directly in the Google Sheet (no web form involved),
// where the user only filled `gmaps_link` and left latitude/longitude blank. Called on
// every GET for assets/locations: resolves any missing coordinates so the map still
// works immediately, AND writes the resolved lat/lng back into the sheet cells so this
// only has to happen once per row (subsequent reads are plain number lookups again).
async function backfillCoordsFromLinks(env, sheetName, rows, idField) {
  const missing = rows.filter((r) => r.gmaps_link && (r.latitude === "" || r.longitude === "" || r.latitude === undefined || r.longitude === undefined));
  if (missing.length === 0) return;

  for (const row of missing) {
    const coords = await resolveGmapsLink(row.gmaps_link, env);
    if (!coords) continue;
    row.latitude = coords.lat;
    row.longitude = coords.lng;
    // Fire-and-forget-ish write-back; awaited so we don't hammer the Sheets API
    // with overlapping writes, but failures here shouldn't break the GET response.
    try {
      await updateRow(env, sheetName, idField, {
        [idField]: row[idField],
        latitude: coords.lat,
        longitude: coords.lng,
      });
    } catch (e) {
      // Sheet write-back failed (e.g. transient API error) — the response still has
      // the resolved coords this time, it'll just re-resolve next GET too.
    }
  }
}

// ------------------------------------------------------------
// Google Maps link -> {lat, lng}
// ------------------------------------------------------------
//
// Accepts anything a user might paste from the "Share" button in Google Maps
// (app or web), a desktop URL copied from the address bar, or a raw
// "lat,lng" pair typed by hand:
//
//   https://maps.app.goo.gl/xxxxxxxx                                (short link, needs a redirect fetch)
//   https://goo.gl/maps/xxxxxxxx                                    (old short link, same handling)
//   https://www.google.com/maps/place/Name/@-6.2615,106.8106,17z/... (place link with @lat,lng)
//   https://www.google.com/maps/place/.../data=!...!3d-6.2615!4d106.8106  (place data param)
//   https://www.google.com/maps?q=-6.2615,106.8106                  (q= query param)
//   https://www.google.com/maps/@-6.2615,106.8106,15z               (plain @lat,lng, no place)
//   -6.2615, 106.8106                                                (typed coordinates)

const SHORT_LINK_HOSTS = ["maps.app.goo.gl", "goo.gl"];

function extractLatLngFromUrl(text) {
  if (!text) return null;

  // Most precise: the !3d<lat>!4d<lng> pair Google embeds for the actual pin
  let m = text.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/);
  if (m) return { lat: parseFloat(m[1]), lng: parseFloat(m[2]) };

  // @lat,lng,zoom — the map viewport center, present on almost every maps.google.com URL
  m = text.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (m) return { lat: parseFloat(m[1]), lng: parseFloat(m[2]) };

  // ?q=lat,lng or &ll=lat,lng
  m = text.match(/[?&](?:q|query|ll)=(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (m) return { lat: parseFloat(m[1]), lng: parseFloat(m[2]) };

  // Plain "lat, lng" typed directly, no URL at all
  m = text.trim().match(/^(-?\d+\.\d+)\s*,\s*(-?\d+\.\d+)$/);
  if (m) return { lat: parseFloat(m[1]), lng: parseFloat(m[2]) };

  return null;
}

async function resolveGmapsLink(rawLink, env) {
  const link = (rawLink || "").toString().trim();
  if (!link) return null;

  // Try extracting directly first (covers full/desktop links and typed coordinates)
  let coords = extractLatLngFromUrl(decodeUrlSafe(link)) || extractLatLngFromUrl(link);
  if (coords) return coords;

  // Short links (maps.app.goo.gl, goo.gl/maps) don't contain coordinates in the URL
  // itself — we have to follow the redirect(s) to Google's real maps.google.com URL.
  let placeNameCandidate = null;
  try {
    const u = new URL(link);
    if (SHORT_LINK_HOSTS.includes(u.hostname)) {
      const result = await followRedirectChainForCoords(link);
      if (result && result.coords) return result.coords;
      placeNameCandidate = result && result.placeName;
    } else {
      placeNameCandidate = extractPlaceName(link);
    }
  } catch (e) {
    // Invalid URL — fall through to the geocoding fallback below (nothing to try there either)
  }

  // Last resort: the link didn't hand us coordinates directly, but it (or the page it
  // redirected to) told us a PLACE NAME (e.g. ".../maps/place/Blok+M+Square/..."). Look
  // that name up via Google's official Geocoding API instead of guessing from page HTML —
  // this only runs if GOOGLE_MAPS_API_KEY is configured, and if it fails we correctly
  // report "unresolved" rather than pointing the marker somewhere wrong.
  if (placeNameCandidate && env && env.GOOGLE_MAPS_API_KEY) {
    coords = await geocodePlaceName(placeNameCandidate, env.GOOGLE_MAPS_API_KEY);
    if (coords) return coords;
  }

  return null;
}

// Pulls a human place name out of a maps.google.com URL, e.g.
// ".../maps/place/Blok+M+Square/@-6.24,106.79,17z/..." -> "Blok M Square"
function extractPlaceName(url) {
  const m = url.match(/\/maps\/place\/([^\/@]+)/);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1].replace(/\+/g, " ")).trim() || null;
  } catch (e) {
    return null;
  }
}

// Looks a place name up via Google's Geocoding API (the same key used for the Maps
// JavaScript API — make sure "Geocoding API" is also enabled for it in Google Cloud
// Console). `region: "id"` biases ambiguous results toward Indonesia.
async function geocodePlaceName(placeName, apiKey) {
  try {
    const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(placeName)}&region=id&key=${apiKey}`;
    const res = await fetch(url);
    const data = await res.json();
    const loc = data && data.results && data.results[0] && data.results[0].geometry && data.results[0].geometry.location;
    if (loc && typeof loc.lat === "number" && typeof loc.lng === "number") {
      return { lat: loc.lat, lng: loc.lng };
    }
  } catch (e) {
    // network/API error — treated as unresolved
  }
  return null;
}

// Walks the HTTP redirect chain ONE HOP AT A TIME (redirect: "manual"), reading only the
// `Location` header at each hop — never the rendered page body/HTML. This is deliberate:
// an earlier version fell back to scanning the final page's HTML for a lat/lng-looking
// pattern when the URL itself didn't have one, and that occasionally matched an unrelated
// coordinate elsewhere on the page (e.g. a consent/interstitial page Google can show to
// non-browser requests), silently pointing the marker at the wrong city. Reading only
// Location headers is far more trustworthy: that's the literal address Google is sending
// the request to, so if it doesn't contain coordinates we correctly report "unresolved"
// instead of guessing.
async function followRedirectChainForCoords(startUrl, maxHops = 6) {
  let current = startUrl;
  let lastPlaceName = null;
  const browserHeaders = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  };

  for (let hop = 0; hop < maxHops; hop++) {
    const decoded = decodeUrlSafe(current);
    let coords = extractLatLngFromUrl(decoded) || extractLatLngFromUrl(current);
    if (coords) return { coords, placeName: null };

    lastPlaceName = extractPlaceName(decoded) || extractPlaceName(current) || lastPlaceName;

    let res;
    try {
      res = await fetch(current, { redirect: "manual", headers: browserHeaders });
    } catch (e) {
      return { coords: null, placeName: lastPlaceName };
    }

    const location = res.headers.get("location");
    if (!location) {
      // No further redirect and no coordinates in the URL we ended on. We do NOT read
      // res.text() here on purpose (see comment above) — return whatever place name we
      // picked up along the way so the caller can try the Geocoding API instead.
      return { coords: null, placeName: lastPlaceName };
    }
    current = new URL(location, current).toString();
  }
  return { coords: null, placeName: lastPlaceName }; // too many hops — bail out rather than loop forever
}

// Google's redirect chain sometimes wraps the real destination as a percent-encoded
// `continue=` / `q=` parameter (e.g. consent.google.com?continue=https%3A%2F%2Fwww...
// %40-6.24...%2C106.79...). Decoding lets our plain-text regexes see the "@" and ","
// characters that would otherwise be hidden as %40 / %2C.
function decodeUrlSafe(text) {
  try {
    return decodeURIComponent(text);
  } catch (e) {
    return text;
  }
}

// Mutates `body` in place: if body.gmaps_link is present and resolvable, overwrites
// body.latitude / body.longitude with the resolved coordinates. Leaves existing
// latitude/longitude untouched if the link is missing or can't be resolved, so a
// bad paste never wipes out a previously-good pin.
async function resolveGmapsLinkInPlace(body, env) {
  if (!body || !body.gmaps_link) return;
  const coords = await resolveGmapsLink(body.gmaps_link, env);
  if (coords) {
    body.latitude = coords.lat;
    body.longitude = coords.lng;
  }
}

// ------------------------------------------------------------
// Sheet read / write helpers (Sheets API v4, values.* endpoints)
// ------------------------------------------------------------

async function readSheet(env, sheetName) {
  const token = await getAccessToken(env);
  const sheetId = env.GOOGLE_SHEET_ID;
  const range = `${sheetName}!A1:Z1000`;
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(range)}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const data = await res.json();
  const values = data.values || [];
  if (values.length === 0) return [];

  const headers = values[0];
  return values.slice(1).map((row) => {
    const obj = {};
    headers.forEach((h, i) => (obj[h] = row[i] !== undefined ? row[i] : ""));
    return obj;
  });
}

async function appendRow(env, sheetName, rowObj) {
  const token = await getAccessToken(env);
  const sheetId = env.GOOGLE_SHEET_ID;

  // Read header row first so values line up with existing columns
  const headerRes = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(sheetName + "!A1:Z1")}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const headerData = await headerRes.json();
  const headers = (headerData.values && headerData.values[0]) || Object.keys(rowObj);
  const row = headers.map((h) => (rowObj[h] !== undefined ? rowObj[h] : ""));

  await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(sheetName + "!A1")}:append?valueInputOption=USER_ENTERED`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ values: [row] }),
    }
  );
}

async function updateRow(env, sheetName, idField, rowObj) {
  const token = await getAccessToken(env);
  const sheetId = env.GOOGLE_SHEET_ID;

  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(sheetName + "!A1:Z1000")}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const data = await res.json();
  const values = data.values || [];
  const headers = values[0] || [];
  const idColIndex = headers.indexOf(idField);
  if (idColIndex === -1) throw new Error(`Column ${idField} not found in ${sheetName}`);

  const rowIndex = values.findIndex((r, i) => i > 0 && r[idColIndex] === rowObj[idField]);
  if (rowIndex === -1) throw new Error(`Row with ${idField}=${rowObj[idField]} not found`);

  const row = headers.map((h) => (rowObj[h] !== undefined ? rowObj[h] : values[rowIndex][headers.indexOf(h)] || ""));
  const targetRange = `${sheetName}!A${rowIndex + 1}:Z${rowIndex + 1}`;

  await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(targetRange)}?valueInputOption=USER_ENTERED`,
    {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ values: [row] }),
    }
  );
}
