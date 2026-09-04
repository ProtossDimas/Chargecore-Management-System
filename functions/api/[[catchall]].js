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
//   GOOGLE_MAPS_API_KEY            your Google Maps JavaScript API key
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
//   only fill `gmaps_link` when entering rows directly in the Sheet. The server resolves
//   coordinates from the link automatically in two places:
//     1. On every POST/PUT from the web form (resolveGmapsLinkInPlace).
//     2. On every GET, for any row that still has an empty latitude/longitude but a
//        gmaps_link (backfillCoordsFromLinks) — it resolves the link, returns the
//        coordinates immediately for the map, and writes them back into the Sheet so
//        it only has to resolve that row once.
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
      const coords = await resolveGmapsLink(body.link || body.gmaps_link || "");
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
        await resolveGmapsLinkInPlace(body);
        await appendRow(env, sheetName, body);
        return json({ ok: true }, cors);
      }

      if (request.method === "PUT") {
        const body = await request.json();
        await resolveGmapsLinkInPlace(body);
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
    const coords = await resolveGmapsLink(row.gmaps_link);
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

async function resolveGmapsLink(rawLink) {
  const link = (rawLink || "").toString().trim();
  if (!link) return null;

  // Try extracting directly first (covers full/desktop links and typed coordinates)
  let coords = extractLatLngFromUrl(link);
  if (coords) return coords;

  // Short links (maps.app.goo.gl, goo.gl/maps) don't contain coordinates in the
  // URL itself — we have to follow the redirect to Google's real maps.google.com URL.
  try {
    const u = new URL(link);
    if (SHORT_LINK_HOSTS.includes(u.hostname)) {
      const res = await fetch(link, { redirect: "follow" });
      // res.url is the final, expanded URL after following redirects
      coords = extractLatLngFromUrl(res.url);
      if (coords) return coords;
      // Some redirects land on an HTML page instead of exposing coords in the URL;
      // fall back to scanning the page body for the same patterns.
      const body = await res.text();
      coords = extractLatLngFromUrl(body);
      if (coords) return coords;
    }
  } catch (e) {
    // Invalid URL or network/redirect failure — treated as unresolved below
  }

  return null;
}

// Mutates `body` in place: if body.gmaps_link is present and resolvable, overwrites
// body.latitude / body.longitude with the resolved coordinates. Leaves existing
// latitude/longitude untouched if the link is missing or can't be resolved, so a
// bad paste never wipes out a previously-good pin.
async function resolveGmapsLinkInPlace(body) {
  if (!body || !body.gmaps_link) return;
  const coords = await resolveGmapsLink(body.gmaps_link);
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
