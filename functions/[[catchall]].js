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
//                 | location_id | location_name | city | latitude | longitude
//                 | installation_date | status | last_maintenance
//
//   Locations     | location_id | location_name | location_type | city | latitude | longitude
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
        return json(rows, cors);
      }

      if (request.method === "POST") {
        const body = await request.json();
        await appendRow(env, sheetName, body);
        return json({ ok: true }, cors);
      }

      if (request.method === "PUT") {
        const body = await request.json();
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
