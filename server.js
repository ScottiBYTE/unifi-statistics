const express = require("express");
const axios = require("axios");

const fs = require("fs");
const path = require("path");
const packageJson = require("./package.json");

const https = require("https");

let puppeteer = null;
try {
  puppeteer = require("puppeteer-core");
} catch {
  puppeteer = null;
}

function loadConfig() {
  const fallbackPath = "./config.json";
  let fileConfig = {};

  if (fs.existsSync(fallbackPath) && fs.statSync(fallbackPath).isFile()) {
    try {
      fileConfig = JSON.parse(fs.readFileSync(fallbackPath, "utf8"));
    } catch {
      console.warn("Warning: config.json exists but could not be parsed.");
    }
  }

  const config = {
    unifiUrl: process.env.UNIFI_URL || fileConfig.unifiUrl || "",
    username: process.env.UNIFI_USERNAME || fileConfig.username || "",
    password: process.env.UNIFI_PASSWORD || fileConfig.password || "",
    site: process.env.UNIFI_SITE || fileConfig.site || "default",
    port: Number(process.env.PORT || fileConfig.port || 3050),
    networkSubnet: process.env.NETWORK_SUBNET || fileConfig.networkSubnet || "172.16.0.0/16",
    internetProvider: process.env.INTERNET_PROVIDER || fileConfig.internetProvider || "",
    appVersion: process.env.APP_VERSION || fileConfig.appVersion || packageJson.version || "0.0.0"
  };

  const missing = [];
  if (!config.unifiUrl) missing.push("UNIFI_URL");
  if (!config.username) missing.push("UNIFI_USERNAME");
  if (!config.password) missing.push("UNIFI_PASSWORD");

  if (missing.length > 0) {
    console.error("");
    console.error("Missing required UniFi configuration:");
    missing.forEach(v => console.error(`  - ${v}`));
    console.error("");
  }

  return config;
}

const config = loadConfig();

const app = express();
app.use(express.json());
app.use(express.static("public"));

const DATA_DIR = "./data";
const CLIENT_DB_FILE = path.join(DATA_DIR, "clients.json");
const BASELINE_FILE = path.join(DATA_DIR, "baseline.json");
const APP_VERSIONS_FILE = path.join(DATA_DIR, "appVersions.json");
const RELEASE_URL_CACHE_FILE = path.join(DATA_DIR, "releaseUrlCache.json");

const DAY_MS = 24 * 60 * 60 * 1000;
const OFFLINE_GRACE_MS = 90 * 1000;
const HISTORY_LIMIT = 240;
const APP_VERSION_CACHE_MS = 5 * 60 * 1000;

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

let knownClients = {};
let baselineState = {
  startedAt: Date.now(),
  complete: false
};

let bandwidthHistory = [];
let gatewayHistory = [];
let cookie = "";

let loginInProgress = null;
let lastLoginAttempt = 0;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

let appVersionCache = {
  ts: 0,
  data: {
    versions: {
      unifiOS: null,
      network: null,
      protect: null,
      talk: null,
      access: null
    },
    updates: {
      unifiOS: false,
      network: false,
      protect: false,
      talk: false,
      access: false
    },
    status: {
      unifiOS: "unknown",
      network: "unknown",
      protect: "unknown",
      talk: "unknown",
      access: "notInstalled"
    }
  }
};

if (fs.existsSync(CLIENT_DB_FILE)) {
  try {
    knownClients = JSON.parse(fs.readFileSync(CLIENT_DB_FILE, "utf8"));
  } catch {
    knownClients = {};
  }
}

if (fs.existsSync(BASELINE_FILE)) {
  try {
    baselineState = JSON.parse(fs.readFileSync(BASELINE_FILE, "utf8"));
  } catch {
    baselineState = { startedAt: Date.now(), complete: false };
  }
}

const agent = new https.Agent({ rejectUnauthorized: false });

const client = axios.create({
  baseURL: config.unifiUrl,
  httpsAgent: agent,
  withCredentials: true,
  validateStatus: () => true
});

// ---------- AUTH ----------

const AUTH_SESSION_MAX_AGE_MS = Number(process.env.UNIFI_SESSION_MAX_AGE_MS || (20 * 60 * 1000));
const AUTH_MIN_LOGIN_GAP_MS = Number(process.env.UNIFI_MIN_LOGIN_GAP_MS || 15000);
const AUTH_RATE_LIMIT_BACKOFF_MS = Number(process.env.UNIFI_RATE_LIMIT_BACKOFF_MS || (2 * 60 * 1000));
const UNIFI_REQUEST_TIMEOUT_MS = Number(process.env.UNIFI_REQUEST_TIMEOUT_MS || 15000);

let authSession = {
  createdAt: 0,
  rateLimitedUntil: 0,
  lastLoginStatus: null,
  lastLoginMessage: ""
};

function sessionIsValid() {
  return !!cookie && Date.now() - authSession.createdAt < AUTH_SESSION_MAX_AGE_MS;
}

function cleanCookieHeader(setCookieHeaders) {
  return (setCookieHeaders || [])
    .map(c => String(c).split(";")[0])
    .filter(Boolean)
    .join("; ");
}

function clearUnifiSession() {
  cookie = "";
  authSession.createdAt = 0;
}

function rateLimitSecondsRemaining() {
  return Math.max(1, Math.ceil((authSession.rateLimitedUntil - Date.now()) / 1000));
}

async function login(force = false) {
  if (!force && sessionIsValid()) {
    return cookie;
  }

  if (loginInProgress) {
    return loginInProgress;
  }

  loginInProgress = (async () => {
    const now = Date.now();

    if (authSession.rateLimitedUntil && authSession.rateLimitedUntil > now) {
      throw new Error(`Login temporarily rate limited by UniFi. Retry in ${rateLimitSecondsRemaining()} seconds.`);
    }

    const sinceLastLogin = now - lastLoginAttempt;
    if (sinceLastLogin < AUTH_MIN_LOGIN_GAP_MS) {
      await sleep(AUTH_MIN_LOGIN_GAP_MS - sinceLastLogin);
    }

    lastLoginAttempt = Date.now();

    const response = await client.post(
      "/api/auth/login",
      {
        username: config.username,
        password: config.password,
        remember: false
      },
      {
        timeout: UNIFI_REQUEST_TIMEOUT_MS
      }
    );

    authSession.lastLoginStatus = response.status;

    if (response.status === 429) {
      authSession.rateLimitedUntil = Date.now() + AUTH_RATE_LIMIT_BACKOFF_MS;
      authSession.lastLoginMessage = "Login failed: 429 rate limited.";
      throw new Error(`Login failed: 429 rate limited. Backing off for ${Math.round(AUTH_RATE_LIMIT_BACKOFF_MS / 1000)} seconds.`);
    }

    const cookieHeader = cleanCookieHeader(response.headers["set-cookie"]);

    if (response.status < 200 || response.status >= 300 || !cookieHeader) {
      authSession.lastLoginMessage = `Login failed: ${response.status}`;
      throw new Error(`Login failed: ${response.status}`);
    }

    cookie = cookieHeader;
    authSession.createdAt = Date.now();
    authSession.rateLimitedUntil = 0;
    authSession.lastLoginMessage = "Login succeeded.";

    return cookie;
  })();

  try {
    return await loginInProgress;
  } finally {
    loginInProgress = null;
  }
}

async function unifiRequest(method, apiPath, options = {}) {
  const optional = options.optional === true;
  const retry = options.retry !== false;

  try {
    const cookieHeader = await login(false);

    let response = await client.request({
      method,
      url: apiPath,
      headers: { Cookie: cookieHeader },
      timeout: UNIFI_REQUEST_TIMEOUT_MS
    });

    if ((response.status === 401 || response.status === 403) && retry) {
      clearUnifiSession();

      const freshCookieHeader = await login(true);

      response = await client.request({
        method,
        url: apiPath,
        headers: { Cookie: freshCookieHeader },
        timeout: UNIFI_REQUEST_TIMEOUT_MS
      });
    }

    if (response.status === 429) {
      authSession.rateLimitedUntil = Date.now() + AUTH_RATE_LIMIT_BACKOFF_MS;

      if (optional) return null;

      throw new Error(`UniFi API rate limited: 429 on ${apiPath}`);
    }

    if (response.status >= 400) {
      if (optional) return null;

      throw new Error(`UniFi API error ${response.status} on ${apiPath}`);
    }

    return response.data;
  } catch (err) {
    if (optional) return null;
    throw err;
  }
}

async function unifiGet(apiPath) {
  return unifiRequest("get", apiPath);
}

async function unifiTry(apiPath) {
  return unifiRequest("get", apiPath, { optional: true });
}

// ---------- HELPERS ----------

function saveKnownClients() {
  fs.writeFileSync(CLIENT_DB_FILE, JSON.stringify(knownClients, null, 2));
}

function saveBaseline() {
  fs.writeFileSync(BASELINE_FILE, JSON.stringify(baselineState, null, 2));
}

function numberValue(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function firstNumber(...values) {
  for (const v of values) {
    const n = numberOrNull(v);
    if (n !== null) return n;
  }
  return null;
}

function percentValue(value) {
  const n = numberOrNull(value);
  if (n === null) return null;
  return Number(n.toFixed(1));
}

function bytesToMbps(bytes) {
  return Number(((numberValue(bytes) * 8) / 1000000).toFixed(2));
}

function rateToMbps(value) {
  if (value === null || value === undefined) return 0;
  return bytesToMbps(value);
}

function secondsToUptime(seconds) {
  seconds = Number(seconds || 0);

  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);

  return `${d}d ${h}h ${m}m`;
}

function ageText(ts) {
  if (!ts) return "-";

  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);

  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;

  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;

  return `${Math.floor(h / 24)}d ago`;
}

function nameOf(c) {
  return c.name || c.hostname || c.dns_name || c.display_name || "Unnamed";
}

function normalizeMac(mac) {
  return String(mac || "").toLowerCase();
}

function cleanVendor(value) {
  const vendor = String(value || "").trim();
  if (!vendor || vendor === "-" || vendor.toLowerCase().includes("unknown")) return "";
  return vendor;
}

function pushLimited(arr, item, limit) {
  arr.push(item);
  if (arr.length > limit) arr.splice(0, arr.length - limit);
}

function clientRateMbps(c, keys) {
  for (const key of keys) {
    if (c[key] !== undefined && c[key] !== null) return rateToMbps(c[key]);
  }
  return 0;
}

function pruneOldEvents() {
  const cutoff = Date.now() - DAY_MS;

  for (const mac of Object.keys(knownClients)) {
    const c = knownClients[mac];

    if (c.lastOfflineAt && c.lastOfflineAt < cutoff) c.lastOfflineAt = null;
    if (c.lastReturnedAt && c.lastReturnedAt < cutoff) c.lastReturnedAt = null;
  }
}

function updateBaselineState() {
  if (!baselineState.complete && baselineState.startedAt) {
    if (Date.now() - baselineState.startedAt >= DAY_MS) {
      baselineState.complete = true;
      baselineState.startedAt = null;
      saveBaseline();
    }
  }
}

// ---------- APP VERSION DISCOVERY ----------

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function looksLikeVersion(value) {
  if (value === null || value === undefined) return false;
  return /^\d+\.\d+(\.\d+)?/.test(String(value).trim());
}

function walkObjects(root, visitor, depth = 0, seen = new Set()) {
  if (root === null || root === undefined) return;
  if (depth > 8) return;

  if (typeof root === "object") {
    if (seen.has(root)) return;
    seen.add(root);
  }

  if (Array.isArray(root)) {
    for (const item of root) walkObjects(item, visitor, depth + 1, seen);
    return;
  }

  if (isPlainObject(root)) {
    visitor(root);
    for (const value of Object.values(root)) {
      walkObjects(value, visitor, depth + 1, seen);
    }
  }
}

function objectText(obj) {
  if (!isPlainObject(obj)) return "";

  return [
    obj.name,
    obj.displayName,
    obj.display_name,
    obj.application,
    obj.applicationName,
    obj.application_name,
    obj.id,
    obj.slug,
    obj.key,
    obj.type,
    obj.package,
    obj.packageName,
    obj.package_name,
    obj.service,
    obj.product,
    obj.productName,
    obj.product_name
  ].filter(Boolean).join(" ").toLowerCase();
}

function pickVersionFromObject(obj) {
  if (!isPlainObject(obj)) return null;

  const keys = [
    "version",
    "installedVersion",
    "installed_version",
    "currentVersion",
    "current_version",
    "applicationVersion",
    "application_version",
    "packageVersion",
    "package_version",
    "releaseVersion",
    "release_version",
    "controllerVersion",
    "controller_version",
    "serverVersion",
    "server_version"
  ];

  for (const key of keys) {
    if (looksLikeVersion(obj[key])) return String(obj[key]);
  }

  return null;
}

function findFirstVersion(payload, keys) {
  let found = null;
  const keySet = new Set(keys.map(k => k.toLowerCase()));

  walkObjects(payload, obj => {
    if (found) return;

    for (const [key, value] of Object.entries(obj)) {
      if (keySet.has(key.toLowerCase()) && looksLikeVersion(value)) {
        found = String(value);
        return;
      }
    }
  });

  return found;
}

function findAppInfo(payload, aliases) {
  const aliasList = aliases.map(a => a.toLowerCase());

  let best = {
    version: null,
    update: false
  };

  walkObjects(payload, obj => {
    const text = objectText(obj);
    if (!text) return;

    const matched = aliasList.some(alias => text.includes(alias));
    if (!matched) return;

    const version = pickVersionFromObject(obj);
    if (version && !best.version) best.version = version;
  });

  return best;
}

function normalizeAppVersions(result) {
  const versions = {
    unifiOS: result?.versions?.unifiOS || null,
    network: result?.versions?.network || null,
    protect: result?.versions?.protect || null,
    talk: result?.versions?.talk || null,
    access: result?.versions?.access || null
  };

  return {
    versions,
    updates: {
      unifiOS: false,
      network: false,
      protect: false,
      talk: false,
      access: false
    }
  };
}

async function getAppVersions() {
  const now = Date.now();

  if (now - appVersionCache.ts < APP_VERSION_CACHE_MS) {
    return appVersionCache.data;
  }

  const result = {
    versions: {
      unifiOS: null,
      network: null,
      protect: null,
      talk: null,
      access: null
    },
    updates: {
      unifiOS: false,
      network: false,
      protect: false,
      talk: false,
      access: false
    }
  };

  const site = config.site || "default";

  const probes = await Promise.all([
    unifiTry("/api/system"),
    unifiTry("/api/system/info"),
    unifiTry("/api/applications"),
    unifiTry("/api/applications/installed"),
    unifiTry("/proxy/network/status"),
    unifiTry("/proxy/network/api/self"),
    unifiTry(`/proxy/network/api/s/${site}/stat/sysinfo`),
    unifiTry("/proxy/protect/api/bootstrap"),
    unifiTry("/proxy/talk/api/bootstrap"),
    unifiTry("/proxy/access/api/bootstrap")
  ]);

  for (const payload of probes.filter(Boolean)) {
    result.versions.unifiOS =
      result.versions.unifiOS ||
      findFirstVersion(payload, [
        "unifiOsVersion",
        "unifi_os_version",
        "osVersion",
        "os_version",
        "firmwareVersion",
        "firmware_version",
        "consoleVersion",
        "console_version"
      ]);

    result.versions.network =
      result.versions.network ||
      findFirstVersion(payload, [
        "networkVersion",
        "network_version",
        "controllerVersion",
        "controller_version",
        "serverVersion",
        "server_version"
      ]);

    const network = findAppInfo(payload, ["network", "unifi-network", "unifi network"]);
    const protect = findAppInfo(payload, ["protect", "unifi-protect", "unifi protect"]);
    const talk = findAppInfo(payload, ["talk", "unifi-talk", "unifi talk"]);
    const access = findAppInfo(payload, ["access", "unifi-access", "unifi access"]);
    const os = findAppInfo(payload, ["unifi os", "unifi-os", "console", "system"]);

    result.versions.unifiOS = result.versions.unifiOS || os.version;
    result.versions.network = result.versions.network || network.version;
    result.versions.protect = result.versions.protect || protect.version;
    result.versions.talk = result.versions.talk || talk.version;
    result.versions.access = result.versions.access || access.version;
  }

  let normalized = normalizeAppVersions(result);

  let saved = null;
  if (fs.existsSync(APP_VERSIONS_FILE)) {
    try {
      saved = JSON.parse(fs.readFileSync(APP_VERSIONS_FILE, "utf8"));
    } catch {
      saved = null;
    }
  }

  const discoveredCount = Object.values(normalized.versions).filter(Boolean).length;
  const savedCount = saved?.versions ? Object.values(saved.versions).filter(Boolean).length : 0;

  // Always use saved good values when this probe misses them.
  if (saved?.versions) {
    for (const key of Object.keys(normalized.versions)) {
      if (!normalized.versions[key] && saved.versions[key]) {
        normalized.versions[key] = saved.versions[key];
      }
    }
  }

  for (const key of Object.keys(normalized.updates)) {
    if (!normalized.versions[key]) {
      normalized.updates[key] = false;
    }
  }

  // Only overwrite the saved cache if this probe is at least as complete
  // as the last known good cache. This prevents partial UniFi API responses
  // from wiping out Network/Protect/Talk versions.
  const mergedCount = Object.values(normalized.versions).filter(Boolean).length;

  if (mergedCount >= savedCount && mergedCount > 0) {
    fs.writeFileSync(APP_VERSIONS_FILE, JSON.stringify(normalized, null, 2));
  }

  appVersionCache = {
    ts: now,
    data: normalized
  };

  return normalized;
}

// ---------- TRACKING ----------

function updateClientTracking(currentClients) {
  const now = Date.now();
  const onlineMacs = new Set();

  for (const c of currentClients) {
    if (!c.mac) continue;

    const mac = normalizeMac(c.mac);
    onlineMacs.add(mac);

    const existing = knownClients[mac];

    const normalized = {
      mac,
      name: nameOf(c),
      ip: c.ip || c.fixed_ip || "",
      isWired: c.is_wired === true,
      network: c.network || c.network_name || "",
      oui: c.oui || "",
      apMac: normalizeMac(c.ap_mac || c.apMac || ""),
      switchMac: normalizeMac(c.sw_mac || c.switch_mac || c.switchMac || ""),
      radio: c.radio || "",
      rssi: c.rssi ?? null,
      lastSeen: now,
      online: true
    };

    if (!existing) {
      knownClients[mac] = {
        ...normalized,
        firstDetectedByTool: now,
        lastOfflineAt: null,
        lastReturnedAt: null
      };
      continue;
    }

    const wasOffline = existing.online === false;

    knownClients[mac] = {
      ...existing,
      ...normalized,
      lastOfflineAt: wasOffline ? null : existing.lastOfflineAt,
      lastReturnedAt: wasOffline ? now : existing.lastReturnedAt
    };
  }

  for (const mac of Object.keys(knownClients)) {
    const c = knownClients[mac];

    if (!onlineMacs.has(mac)) {
      const lastSeen = c.lastSeen || 0;
      const missingLongEnough = now - lastSeen >= OFFLINE_GRACE_MS;

      if (c.online === true && missingLongEnough) {
        c.lastOfflineAt = now;
        c.lastReturnedAt = null;
        c.online = false;
        c.firstDetectedByTool = 0;
      }
    }
  }

  pruneOldEvents();
  saveKnownClients();
}

// ---------- BASELINE ----------

function clearBaseline() {
  const now = Date.now();

  for (const mac in knownClients) {
    knownClients[mac].firstDetectedByTool = now - DAY_MS;
    knownClients[mac].lastOfflineAt = null;
    knownClients[mac].lastReturnedAt = null;
  }

  baselineState.complete = true;
  baselineState.startedAt = null;

  saveKnownClients();
  saveBaseline();
}

// ---------- FILTERS ----------

function getNewClients() {
  const cutoff = Date.now() - DAY_MS;

  return Object.values(knownClients)
    .filter(c => c.online === true)
    .filter(c => c.firstDetectedByTool >= cutoff)
    .filter(c => !c.lastOfflineAt)
    .filter(c => !c.lastReturnedAt)
    .sort((a, b) => b.firstDetectedByTool - a.firstDetectedByTool)
    .slice(0, 5)
    .map(c => ({ ...c, firstSeenText: ageText(c.firstDetectedByTool) }));
}

function getOffline() {
  const cutoff = Date.now() - DAY_MS;

  return Object.values(knownClients)
    .filter(c => c.online === false)
    .filter(c => c.lastOfflineAt && c.lastOfflineAt >= cutoff)
    .sort((a, b) => b.lastOfflineAt - a.lastOfflineAt)
    .slice(0, 5)
    .map(c => ({ ...c, offlineText: ageText(c.lastOfflineAt) }));
}

function getReturned() {
  const cutoff = Date.now() - DAY_MS;
  const offlineMacs = new Set(getOffline().map(c => c.mac));

  return Object.values(knownClients)
    .filter(c => c.online === true)
    .filter(c => c.lastReturnedAt && c.lastReturnedAt >= cutoff)
    .filter(c => !offlineMacs.has(c.mac))
    .sort((a, b) => b.lastReturnedAt - a.lastReturnedAt)
    .slice(0, 5)
    .map(c => ({ ...c, returnedText: ageText(c.lastReturnedAt) }));
}

function getUnnamed() {
  return Object.values(knownClients)
    .filter(c => c.online === true)
    .filter(c => !c.name || c.name === "Unnamed")
    .sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0))
    .slice(0, 5)
    .map(c => ({ ...c, lastSeenText: ageText(c.lastSeen) }));
}

function isRealAccessPoint(device) {
  const text = [
    device.name,
    device.hostname,
    device.model,
    device.type,
    device.mac,
    device.displayable_version
  ].filter(Boolean).join(" ").toLowerCase();

  if (
    text.includes("plug") ||
    text.includes("smartpower") ||
    text.includes("smart power") ||
    text.includes("usp-plug") ||
    text.includes("usw-flex-util") ||
    text.includes("power")
  ) {
    return false;
  }

  return device.type === "uap";
}

// ---------- INSIGHTS ----------

function classifyClient(c) {
  const text = `${c.name || ""} ${c.hostname || ""} ${c.dns_name || ""} ${c.oui || ""}`.toLowerCase();

  if (text.match(/camera|cam|reolink|hikvision|amcrest|wyze|arlo|nest cam/)) return "Cameras";
  if (text.match(/tv|roku|vizio|sonos|chromecast|apple tv|fire tv|shield/)) return "TVs & Media";
  if (text.match(/iphone|ipad|android|samsung|pixel|phone|tablet/)) return "Phones & Tablets";
  if (text.match(/server|nas|docker|incus|proxmox|unraid|ubuntu|debian|plex/)) return "Servers";
  if (text.match(/switch|gateway|ubiquiti|unifi|uap|usw|udm/)) return "Infrastructure";
  if (text.match(/echo|alexa|google home|nest|thermostat|plug|bulb|withings|hubitat|shelly|kasa|tuya/)) return "IoT / Smart Home";
  if (text.match(/windows|desktop|laptop|pc|macbook|minisforum/)) return "Computers";

  return "Other";
}

function getTopTalkers(clientList) {
  return clientList
    .map(c => {
      const downMbps = clientRateMbps(c, ["rx_bytes-r", "rx_bytes_r", "rx_rate", "down", "down_rate"]);
      const upMbps = clientRateMbps(c, ["tx_bytes-r", "tx_bytes_r", "tx_rate", "up", "up_rate"]);
      const totalMbps = Number((downMbps + upMbps).toFixed(2));

      return {
        name: nameOf(c),
        ip: c.ip || c.fixed_ip || "-",
        mac: normalizeMac(c.mac),
        vendor: cleanVendor(c.oui),
        isWired: c.is_wired === true,
        downMbps,
        upMbps,
        totalMbps
      };
    })
    .filter(c => c.totalMbps > 0)
    .sort((a, b) => b.totalMbps - a.totalMbps)
    .slice(0, 5);
}

function getApUtilization(aps, clientList) {
  return aps
    .map(ap => {
      const apMac = normalizeMac(ap.mac);
      const connectedClients = clientList.filter(c => normalizeMac(c.ap_mac || c.apMac) === apMac).length;
      const clientCount = Number(ap.num_sta ?? ap.user_num_sta ?? connectedClients ?? 0);
      const radio = Array.isArray(ap.radio_table) ? ap.radio_table[0] || {} : {};

      const utilization = Number(
        ap.utilization ??
        ap.channel_utilization ??
        radio.cu_total ??
        radio.cu_self_rx ??
        0
      );

      return {
        name: ap.name || ap.hostname || ap.model || "Access Point",
        ip: ap.ip || "-",
        clients: clientCount,
        channel: radio.channel || ap.channel || "-",
        utilization: Number.isFinite(utilization) ? Number(utilization.toFixed(1)) : 0,
        status: ap.state === 1 || ap.status === "connected" ? "Online" : "Check"
      };
    })
    .sort((a, b) => b.clients - a.clients)
    .slice(0, 5);
}

function getClientBreakdown(clientList) {
  const buckets = {};

  for (const c of clientList) {
    const category = classifyClient(c);
    buckets[category] = (buckets[category] || 0) + 1;
  }

  const total = clientList.length || 1;

  return Object.entries(buckets)
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => ({
      name,
      count,
      percent: Number(((count / total) * 100).toFixed(1))
    }));
}

function getInternetHealth(wan, gw) {
  const monitors = wan?.uptime_stats?.WAN?.alerting_monitors || [];
  const monitor = monitors.find(m => Number(m.availability) > 0) || monitors[0] || {};

  const availability = percentValue(monitor.availability);
  const latency = firstNumber(
    monitor.latency_average,
    wan.latency,
    wan.ping,
    wan["gw_ping"],
    wan["www_ping"]
  );

  const packetLoss =
    availability === null
      ? firstNumber(wan.packet_loss, wan.loss, wan["packet-loss"], 0)
      : Number(Math.max(0, 100 - availability).toFixed(1));

  const statusText = String(wan.status || wan.state || "Healthy").toLowerCase();

  return {
    status: statusText === "ok" || statusText === "online" || statusText === "healthy" ? "Healthy" : statusText,
    pingMs: latency === null ? null : Number(latency.toFixed(0)),
    availability,
    packetLoss,
    ispName: config.internetProvider || wan.isp_name || wan.isp_organization || "-",
    wanType: wan.wan_type || wan.type || "DHCP"
  };
}

function getNetworkSummary(wan, gw, clientList) {
  const networks = [...new Set(clientList.map(c => c.network || c.network_name).filter(Boolean))];

  return {
    subnet: config.networkSubnet,
    dhcpLeases: clientList.length,
    isp: config.internetProvider || wan.isp_name || wan.isp_organization || "-",
    wanType: wan.wan_type || wan.type || "DHCP",
    gatewayMac: gw.mac || wan.gw_mac || "-",
    gatewayVersion: wan.gw_version || gw.version || "-",
    gatewayModel: gw.model || gw.board_rev || gw.type || wan.gw_model || "-",
    networks: networks.join(", ") || "-",
    systemTime: new Date().toLocaleString()
  };
}

function getAlerts(summary, internetHealth, apUtilization, recentlyOffline) {
  const alerts = [];

  if (summary.cpu !== null && Number(summary.cpu) >= 85) {
    alerts.push({ level: "critical", title: "High Gateway CPU", message: `Gateway CPU is ${summary.cpu}%`, age: "now" });
  } else if (summary.cpu !== null && Number(summary.cpu) >= 70) {
    alerts.push({ level: "warn", title: "Elevated Gateway CPU", message: `Gateway CPU is ${summary.cpu}%`, age: "now" });
  }

  if (summary.memory !== null && Number(summary.memory) >= 90) {
    alerts.push({ level: "warn", title: "High Memory Usage", message: `Gateway memory is ${summary.memory}%`, age: "now" });
  }

  if (internetHealth.packetLoss !== null && internetHealth.packetLoss > 1) {
    alerts.push({ level: "warn", title: "WAN Packet Loss", message: `${internetHealth.packetLoss}% packet loss detected`, age: "now" });
  }

  if (internetHealth.pingMs !== null && internetHealth.pingMs >= 80) {
    alerts.push({ level: "warn", title: "High WAN Latency", message: `WAN latency is ${internetHealth.pingMs} ms`, age: "now" });
  }

  for (const ap of apUtilization) {
    if (ap.utilization >= 70) {
      alerts.push({ level: "warn", title: "High AP Utilization", message: `${ap.name} is at ${ap.utilization}% utilization`, age: "now" });
    }
  }

  if (recentlyOffline.length > 0) {
    alerts.push({
      level: "info",
      title: "Recent Client Offline Event",
      message: `${recentlyOffline.length} client(s) recently went offline`,
      age: recentlyOffline[0]?.offlineText || "recent"
    });
  }

  return alerts.slice(0, 10);
}

// ---------- MAIN COLLECTION ----------

async function collectStats() {
  const site = config.site || "default";

  const [devices, clients, health, appInfo] = await Promise.all([
    unifiGet(`/proxy/network/api/s/${site}/stat/device`),
    unifiGet(`/proxy/network/api/s/${site}/stat/sta`),
    unifiGet(`/proxy/network/api/s/${site}/stat/health`),
    getAppVersions()
  ]);

  const deviceList = devices.data || [];
  const clientList = clients.data || [];
  const healthList = health.data || [];

  updateBaselineState();
  updateClientTracking(clientList);

  const gateways = deviceList.filter(d => d.type === "udm" || d.type === "ugw");
  const switches = deviceList.filter(d => d.type === "usw");
  const aps = deviceList.filter(isRealAccessPoint);

  const gw = gateways[0] || {};
  const wan = healthList.find(h => h.subsystem === "wan") || {};

  const sample = {
    time: Date.now(),
    down: bytesToMbps(wan["rx_bytes-r"] || 0),
    up: bytesToMbps(wan["tx_bytes-r"] || 0)
  };

  pushLimited(bandwidthHistory, sample, HISTORY_LIMIT);

  const cpu = percentValue(wan["gw_system-stats"]?.cpu ?? gw.system_stats?.cpu ?? gw["system-stats"]?.cpu);
  const memory = percentValue(wan["gw_system-stats"]?.mem ?? gw.system_stats?.mem ?? gw["system-stats"]?.mem);

  pushLimited(gatewayHistory, {
    time: Date.now(),
    cpu: cpu || 0,
    memory: memory || 0
  }, HISTORY_LIMIT);

  const newClients = getNewClients();
  const recentlyOffline = getOffline();
  const recentlyReturned = getReturned();
  const unnamedClients = getUnnamed();

  const summary = {
    gatewayName: gw.name || wan.gw_name || "Gateway",
    wanIp: wan.wan_ip || gw.ip || "-",
    uptime: secondsToUptime(
      gw.system_stats?.uptime ||
      gw["system-stats"]?.uptime ||
      wan["gw_system-stats"]?.uptime ||
      gw.uptime ||
      0
    ),
    cpu,
    memory,
    downloadMbps: sample.down,
    uploadMbps: sample.up
  };

const internetHealth = getInternetHealth(wan, gw);
const apUtilization = getApUtilization(aps, clientList);
const alerts = getAlerts(summary, internetHealth, apUtilization, recentlyOffline);
const networkSummary = getNetworkSummary(wan, gw, clientList);

appVersionCache.lastGatewayModel = networkSummary.gatewayModel;
appVersionCache.lastGatewayName = summary.gatewayName;

// ----- VERSION FALLBACKS -----

if (!appInfo.versions.unifiOS && networkSummary.gatewayVersion) {
  appInfo.versions.unifiOS = String(networkSummary.gatewayVersion)
    .split(".")
    .slice(0, 3)
    .join(".");
}
if (!appInfo.versions.protect) {
  appInfo.versions.protect = null;
}

if (!appInfo.versions.talk) {
  appInfo.versions.talk = null;
}

if (!appInfo.versions.access) {
  appInfo.versions.access = null;
}

for (const key of Object.keys(appInfo.updates)) {
  if (!appInfo.versions[key]) {
    appInfo.updates[key] = false;
  }
}

return {

    summary,
    versions: appInfo.versions,
    updates: appInfo.updates,
    appStatus: {
      unifiOS: appInfo.versions.unifiOS ? "running" : "unknown",
      network: appInfo.versions.network ? "running" : "unknown",
      protect: appInfo.versions.protect ? "running" : "notInstalled",
      talk: appInfo.versions.talk ? "running" : "notInstalled",
      access: appInfo.versions.access ? "running" : "notInstalled"
    },
    counts: {
      clients: clientList.length,
      wiredClients: clientList.filter(c => c.is_wired).length,
      wirelessClients: clientList.filter(c => !c.is_wired).length,
      accessPoints: aps.length,
      switches: switches.length,
      newClients24h: newClients.length,
      recentlyOffline24h: recentlyOffline.length,
      recentlyReturned24h: recentlyReturned.length,
      unnamedClients: unnamedClients.length
    },
    activity: {
      newClients,
      recentlyOffline,
      recentlyReturned,
      unnamedClients
    },
    insights: {
      internetHealth,
      topTalkers: getTopTalkers(clientList),
      apUtilization,
      clientBreakdown: getClientBreakdown(clientList),
      networkSummary,
      appVersions: appInfo.versions,
      appUpdates: appInfo.updates,
      appStatus: {
        unifiOS: appInfo.versions.unifiOS ? "running" : "unknown",
        network: appInfo.versions.network ? "running" : "unknown",
        protect: appInfo.versions.protect ? "running" : "notInstalled",
        talk: appInfo.versions.talk ? "running" : "notInstalled",
        access: appInfo.versions.access ? "running" : "notInstalled"
      },
        alerts
    },
    baselineActive: !baselineState.complete
  };
}





function releaseVersionDash(version) {
  return String(version || "")
    .trim()
    .replace(/^v/i, "")
    .replace(/\./g, "-");
}

function getGatewayModelText() {
  return [
    appVersionCache?.lastGatewayModel,
    appVersionCache?.lastGatewayName
  ].filter(Boolean).join(" ").toLowerCase();
}

function unifiOsReleaseFamily(version) {
  const vDash = releaseVersionDash(version);
  const modelText = getGatewayModelText();

  if (!vDash) return null;

  // Hardware-specific UniFi OS release families.
  // The UUID is different for each family, even when the version number is the same.
  if (modelText.includes("dream wall") || modelText.includes("udw")) {
    return {
      slug: `UniFi-OS-Dream-Wall-${vDash}`,
      title: `UniFi OS - Dream Wall ${String(version).trim()}`
    };
  }

  if (
    modelText.includes("unvr") ||
    modelText.includes("network video recorder") ||
    modelText.includes("enterprise network video")
  ) {
    return {
      slug: `UniFi-OS-Enterprise-Network-Video-Recorders-${vDash}`,
      title: `UniFi OS - Enterprise Network Video Recorders ${String(version).trim()}`
    };
  }

  if (
    modelText.includes("nas") ||
    modelText.includes("network attached storage")
  ) {
    return {
      slug: `UniFi-OS-Network-Attached-Storage-${vDash}`,
      title: `UniFi OS - Network Attached Storage ${String(version).trim()}`
    };
  }

  if (
    modelText.includes("uck") ||
    modelText.includes("cloud key")
  ) {
    return {
      slug: `UniFi-OS-Cloud-Keys-${vDash}`,
      title: `UniFi OS - Cloud Keys ${String(version).trim()}`
    };
  }

  if (
    modelText.includes("ucg") ||
    modelText.includes("uxg") ||
    modelText.includes("cloud gateway")
  ) {
    return {
      slug: `UniFi-OS-Cloud-Gateways-${vDash}`,
      title: `UniFi OS - Cloud Gateways ${String(version).trim()}`
    };
  }

  if (
    modelText.includes("ux") ||
    modelText.includes("express")
  ) {
    return {
      slug: `UniFi-OS-Express-${vDash}`,
      title: `UniFi OS - Express ${String(version).trim()}`
    };
  }

  // UDM Beast / Dream Machine family.
  if (
    modelText.includes("udm") ||
    modelText.includes("dream") ||
    modelText.includes("udmea")
  ) {
    return {
      slug: `UniFi-OS-Dream-Machines-${vDash}`,
      title: `UniFi OS - Dream Machines ${String(version).trim()}`
    };
  }

  // Your environment is a Dream Machine-class gateway, so defaulting here is safer
  // than resolving to a generic UniFi OS page.
  return {
    slug: `UniFi-OS-Dream-Machines-${vDash}`,
    title: `UniFi OS - Dream Machines ${String(version).trim()}`
  };
}

function releaseSvcPaths(app, version) {
  const v = String(version || "").trim();
  if (!v || v === "-" || v.toLowerCase() === "n/a") return [];

  const encoded = encodeURIComponent(v);

  const map = {
    network: ["network"],
    protect: ["protect"],
    talk: ["talk"],
    access: ["access"]
  };

  return (map[app] || [])
    .map(slug => `https://community.svc.ui.com/releases/${slug}/${encoded}`);
}

const HEADLESS_RELEASE_CACHE_MS = 12 * 60 * 60 * 1000;
let headlessReleaseCache = {};

function unifiOsReleaseTitleSlugs(version) {
  const family = unifiOsReleaseFamily(version);
  return family ? [family.slug] : [];
}

function browserReleaseTitleSlug(appName, version) {
  const vDash = releaseVersionDash(version);
  if (!vDash) return "";

  if (appName === "unifiOS") {
    return unifiOsReleaseTitleSlugs(version)[0] || "";
  }

  const map = {
    network: `UniFi-Network-Application-${vDash}`,
    protect: `UniFi-Protect-Application-${vDash}`,
    talk: `UniFi-Talk-Application-${vDash}`,
    access: `UniFi-Access-Application-${vDash}`
  };

  return map[appName] || "";
}

function chromiumExecutablePath() {
  const candidates = [
    process.env.CHROMIUM_EXECUTABLE,
    process.env.PUPPETEER_EXECUTABLE_PATH,
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome"
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // Try next candidate.
    }
  }

  return candidates[0] || "/usr/bin/chromium-browser";
}

function normalizeReleaseText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function canonicalReleaseUrl(rawHref, slug) {
  if (!rawHref || !slug) return null;

  let url;
  try {
    url = new URL(rawHref, "https://community.ui.com");
  } catch {
    return null;
  }

  if (url.hash && url.hash.includes("comment")) return null;

  const uuidMatch = url.pathname.match(/\/releases\/(?:[^/]+\/)?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
  if (!uuidMatch) return null;

  return `https://community.ui.com/releases/${slug}/${uuidMatch[1]}`;
}

async function resolveReleaseUrlWithHeadlessBrowser(appName, version) {
  if (!puppeteer) return null;

  const cacheKey = `${appName}:${String(version || "").trim()}:${getGatewayModelText()}`;
  const cached = headlessReleaseCache[cacheKey];

  if (cached && Date.now() - cached.ts < HEADLESS_RELEASE_CACHE_MS) {
    return cached.url;
  }

  let targets = [];

  if (appName === "unifiOS") {
    const family = unifiOsReleaseFamily(version);
    if (!family) return null;
    targets = [family];
  } else {
    const slug = browserReleaseTitleSlug(appName, version);
    if (!slug) return null;

    const titleMap = {
      network: `UniFi Network Application ${String(version).trim()}`,
      protect: `UniFi Protect Application ${String(version).trim()}`,
      talk: `UniFi Talk Application ${String(version).trim()}`,
      access: `UniFi Access Application ${String(version).trim()}`
    };

    targets = [{
      slug,
      title: titleMap[appName] || slug.replace(/-/g, " ")
    }];
  }

  let browser = null;

  try {
    browser = await puppeteer.launch({
      executablePath: chromiumExecutablePath(),
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--no-zygote"
      ]
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1600, height: 1000 });

    await page.setUserAgent(
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
    );

    for (const target of targets) {
      const expectedNormalized = normalizeReleaseText(target.title);

      await page.goto("https://community.ui.com/releases", {
        waitUntil: "networkidle2",
        timeout: 45000
      });

      await new Promise(resolve => setTimeout(resolve, 4000));

      await page.focus("input[type='search']");
      await page.keyboard.down("Control");
      await page.keyboard.press("A");
      await page.keyboard.up("Control");
      await page.keyboard.press("Backspace");
      await page.keyboard.type(target.title, { delay: 35 });

      await new Promise(resolve => setTimeout(resolve, 12000));

      const href = await page.evaluate(expectedNormalized => {
        const normalize = value => String(value || "")
          .toLowerCase()
          .replace(/&/g, " and ")
          .replace(/[^a-z0-9]+/g, " ")
          .replace(/\s+/g, " ")
          .trim();

        const uuidRelease = href =>
          /\/releases\/(?:[^/]+\/)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(href || "").split("#")[0]);

        const candidates = Array.from(document.querySelectorAll("a[href*='/releases/']"))
          .map(a => {
            const card = a.closest("article, li, section, div");
            const ownText = [
              a.innerText,
              a.textContent,
              a.getAttribute("aria-label"),
              a.getAttribute("title")
            ].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();

            const cardText = card
              ? String(card.innerText || "").replace(/\s+/g, " ").trim()
              : "";

            return {
              href: String(a.href || "").split("#")[0],
              normalizedOwnText: normalize(ownText),
              normalizedCardText: normalize(cardText)
            };
          })
          .filter(item =>
            item.href &&
            !item.href.includes("#comment") &&
            uuidRelease(item.href)
          );

        let exact = candidates.find(item =>
          item.normalizedOwnText === expectedNormalized ||
          item.normalizedOwnText.startsWith(`${expectedNormalized} `) ||
          item.normalizedCardText === expectedNormalized ||
          item.normalizedCardText.startsWith(`${expectedNormalized} `)
        );

        if (exact) return exact.href;

        exact = candidates.find(item =>
          item.normalizedCardText.includes(expectedNormalized)
        );

        return exact ? exact.href : null;
      }, expectedNormalized);

      const cleanUrl = canonicalReleaseUrl(href, target.slug);

      if (cleanUrl) {
        console.log(`Resolved ${appName} ${version} release URL: ${cleanUrl}`);

        headlessReleaseCache[cacheKey] = {
          ts: Date.now(),
          url: cleanUrl
        };

        return cleanUrl;
      }
    }

    return null;
  } catch (err) {
    console.warn(`Headless release lookup failed for ${appName} ${version}: ${err.message}`);
    return null;
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch {
        // Ignore browser shutdown errors.
      }
    }
  }
}

function loadReleaseUrlCache() {
  try {
    if (!fs.existsSync(RELEASE_URL_CACHE_FILE)) return {};
    return JSON.parse(fs.readFileSync(RELEASE_URL_CACHE_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveReleaseUrlCache(cache) {
  try {
    fs.writeFileSync(RELEASE_URL_CACHE_FILE, JSON.stringify(cache, null, 2));
  } catch {
    // Ignore cache write failures.
  }
}

function releaseCacheKeys(appName, version) {
  const v = String(version || "").trim();

  if (appName === "unifiOS") {
    const family = unifiOsReleaseFamily(version);
    return [
      `${appName}:${v}:${family?.slug || ""}`,
      `${appName}:${v}`
    ];
  }

  return [`${appName}:${v}`];
}

function getCachedReleaseUrl(appName, version) {
  const cache = loadReleaseUrlCache();

  for (const key of releaseCacheKeys(appName, version)) {
    const entry = cache[key];

    if (typeof entry === "string" && entry.includes("community.ui.com/releases")) {
      return entry;
    }

    if (entry?.url && entry.url.includes("community.ui.com/releases")) {
      return entry.url;
    }
  }

  return null;
}

function putCachedReleaseUrl(appName, version, url) {
  if (!url || !url.includes("community.ui.com/releases")) return;

  const cache = loadReleaseUrlCache();
  const keys = releaseCacheKeys(appName, version);

  for (const key of keys) {
    cache[key] = {
      url,
      ts: Date.now()
    };
  }

  saveReleaseUrlCache(cache);
}

async function resolveReleaseUrl(appName, version) {
  const cachedUrl = getCachedReleaseUrl(appName, version);
  if (cachedUrl) return cachedUrl;

  const candidates = releaseSvcPaths(appName, version);

  for (const svcUrl of candidates) {
    try {
      const response = await axios.get(svcUrl, {
        timeout: 8000,
        validateStatus: status => status >= 200 && status < 500
      });

      if (response.data?.url && response.data.url.includes("community.ui.com/releases")) {
        putCachedReleaseUrl(appName, version, response.data.url);
        return response.data.url;
      }
    } catch {
      // Try the next candidate.
    }
  }

  const exactUrl = await resolveReleaseUrlWithHeadlessBrowser(appName, version);
  if (exactUrl) {
    putCachedReleaseUrl(appName, version, exactUrl);
    return exactUrl;
  }

  if (appName === "unifiOS") {
    const family = unifiOsReleaseFamily(version);
    if (family) {
      return `https://community.ui.com/releases?q=${encodeURIComponent(family.title)}`;
    }
  }

  return null;
}

// ---------- ROUTES ----------




app.get("/api/app-config", (req, res) => {
  res.json({
    appName: "UniFi Statistics",
    companyName: "SCOTTIBYTE ENTERPRISE CONSULTING SERVICES",
    version: `v${String(config.appVersion || "0.0.0").replace(/^v/i, "")}`,
    githubUrl: config.githubUrl || "https://github.com/ScottiBYTE/unifi-statistics",
    donateUrl: config.donateUrl || "https://www.paypal.com/paypalme/ScottiBYTE"
  });
});


app.get("/api/release-link", async (req, res) => {

  try {
    const appName = String(req.query.app || "");
    const version = String(req.query.version || "");

    const url = await resolveReleaseUrl(appName, version);

    if (url) {
      return res.redirect(url);
    }

    return res.status(404).send("Release notes not found.");
  } catch (err) {
    return res.status(500).send(`Release lookup failed: ${err.message}`);
  }
});


app.get("/api/summary", async (req, res) => {
  try {
    const data = await collectStats();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/app-versions", async (req, res) => {
  try {
    const data = await getAppVersions();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/history", (req, res) => {
  res.json(bandwidthHistory);
});

app.get("/api/gateway-history", (req, res) => {
  res.json(gatewayHistory);
});

app.post("/api/clear-baseline", (req, res) => {
  clearBaseline();
  res.json({
    ok: true,
    message: "Baseline cleared.",
    baselineActive: false
  });
});

// ---------- START ----------

app.listen(config.port || 3050, () => {
  console.log(`UniFi Statistics running on port ${config.port || 3050}`);
});
