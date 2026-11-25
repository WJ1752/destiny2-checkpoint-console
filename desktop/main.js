'use strict';

// 本机屏幕识别服务。只接收用户主动选择的 Twitch 网页可见画面，不连接 Twitch API。
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { URL } = require('node:url');
const { recognizeImage } = require('./vision');

const HOST = process.env.D2_HOST || '127.0.0.1';
if (HOST !== '127.0.0.1') throw new Error('本机应用仅允许绑定 127.0.0.1。');
const PORT = Number(process.env.D2_PORT ?? '0');
if (!Number.isInteger(PORT) || PORT < 0 || PORT > 65535) throw new Error('D2_PORT 必须是 0 到 65535 之间的整数。');
let launchKey = process.env.D2_LAUNCH_KEY || '';
const UI_ROOT = path.join(__dirname, 'ui');
const DATA_ROOT = process.env.D2_DATA_DIR || path.join(process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || process.cwd(), 'AppData', 'Local'), 'D2Checkpoint');
const STATE_FILE = path.join(DATA_ROOT, 'state.json');
const REPORT_TTL_MS = 10 * 60 * 1000;
const FRAME_CONFIRM_TTL_MS = 5 * 60 * 1000;
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
};
const MIME = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8' };
let bootstrapUsed = false;
process.env.D2_LAUNCH_KEY = '';
let sessionId = crypto.randomBytes(32).toString('base64url');
let settings = { watchedChannels: [] };
let reports = [];
let channels = new Map();
const queueObservations = new Map();
const recognizedFrames = new Map();
let lastScanAt = null;
let lastError = '';
let dbWriteChain = Promise.resolve();
const activeScans = new Set();
let activeImageJobs = 0;

fs.mkdirSync(DATA_ROOT, { recursive: true });
try {
  const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  if (saved && typeof saved === 'object') {
    const savedChannels = Array.isArray(saved.settings?.watchedChannels) ? saved.settings.watchedChannels : [];
    settings.watchedChannels = [...new Set(savedChannels.map(cleanLogin).filter(Boolean))].slice(0, 100);
    const currentSchema = saved.schema === 2;
    reports = currentSchema && Array.isArray(saved.reports) ? saved.reports.slice(0, 500).map(report => ({ ...report, status: 'candidate', confidence: '重新打开频道并识别两张不同画面后确认' })) : [];
    for (const item of currentSchema && Array.isArray(saved.channels) ? saved.channels.slice(0, 100) : []) {
      const login = cleanLogin(item?.login); if (!login) continue;
      channels.set(login, { login, displayName: login, lastFrameAt: null, queueLength: Number.isFinite(item.queueLength) ? item.queueLength : null, lastFingerprint: null, previousKeys: new Set() });
    }
    for (const report of reports) {
      if (!channels.has(report.login) && channels.size < 100) channels.set(report.login, { login: report.login, displayName: report.displayName || report.login, lastFrameAt: null, queueLength: null, lastFingerprint: null, previousKeys: new Set() });
    }
    for (const login of settings.watchedChannels) if (!channels.has(login) && channels.size < 100) channels.set(login, { login, displayName: login, lastFrameAt: null, queueLength: null, lastFingerprint: null, previousKeys: new Set() });
  }
} catch {}

function persist() {
  const serializableChannels = [...channels.values()].map(({ login, displayName, queueLength }) => ({ login, displayName, queueLength }));
  const data = JSON.stringify({ schema: 2, settings, reports: reports.slice(-500), channels: serializableChannels, savedAt: new Date().toISOString() });
  const task = dbWriteChain.catch(() => {}).then(() => fs.promises.writeFile(`${STATE_FILE}.tmp`, data, { mode: 0o600 }).then(() => fs.promises.rename(`${STATE_FILE}.tmp`, STATE_FILE)));
  dbWriteChain = task.catch(() => {});
  return task;
}
function reply(res, status, data, headers = {}) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { ...SECURITY_HEADERS, 'Cache-Control':'no-store', ...headers });
  res.end(typeof data === 'string' || Buffer.isBuffer(data) ? data : JSON.stringify(data));
}
function sendJson(res, status, payload, headers = {}) { reply(res, status, payload, { 'Content-Type':'application/json; charset=utf-8', ...headers }); }
function getCookie(req, name) {
  const item = (req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith(`${name}=`));
  return item ? item.slice(name.length + 1) : '';
}
function timingSafeEqualText(a, b) {
  const left = Buffer.from(String(a || ''), 'utf8'); const right = Buffer.from(String(b || ''), 'utf8');
  const leftHash = crypto.createHash('sha256').update(left).digest(); const rightHash = crypto.createHash('sha256').update(right).digest();
  return crypto.timingSafeEqual(leftHash, rightHash) && left.length === right.length;
}
function authenticated(req) { const cookie = getCookie(req, 'd2sid'); return cookie.length === 43 && timingSafeEqualText(cookie, sessionId); }
function consumeLaunchKey(req) {
  if (bootstrapUsed) return false;
  if (launchKey) { if (!timingSafeEqualText(req.headers['x-d2-launch-key'], launchKey)) return false; }
  else {
    const remote = req.socket.remoteAddress;
    const local = remote === '127.0.0.1' || remote === '::ffff:127.0.0.1';
    if (!local || req.headers.host !== `127.0.0.1:${req.socket.localPort}`) return false;
  }
  bootstrapUsed = true; launchKey = ''; return true;
}
function originOkay(req) {
  const port = req.socket.localPort;
  return req.headers.origin === `http://${HOST}:${port}` && req.headers.host === `${HOST}:${port}`;
}
async function readBody(req, cap = 64 * 1024) {
  const chunks = []; let len = 0; let oversized = false;
  for await (const chunk of req) {
    len += chunk.length;
    if (len > cap) { oversized = true; continue; }
    chunks.push(chunk);
  }
  if (oversized) throw Object.assign(new Error('请求内容过大。'), { status: 413 });
  if (len === 0) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('请求内容不是有效 JSON。'), { status: 400 }); }
}
async function withImageJob(req, work) {
  if (activeImageJobs >= 1) {
    req.resume(); // Drain a rejected upload without retaining its body.
    throw Object.assign(new Error('已有画面正在本机 OCR 中，请稍候。'), { status: 429 });
  }
  activeImageJobs += 1;
  try { return await work(); }
  finally { activeImageJobs -= 1; }
}
const PNG_CRC_TABLE = Uint32Array.from({ length: 256 }, (_, seed) => {
  let value = seed;
  for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
  return value >>> 0;
});
function pngCrc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) value = PNG_CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}
function imageDimensions(buffer) {
  if (buffer.length >= 45 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    let offset = 8; let width = 0; let height = 0; let sawHeader = false; let sawData = false; let idatClosed = false;
    while (offset + 12 <= buffer.length) {
      const length = buffer.readUInt32BE(offset);
      if (length > buffer.length - offset - 12) return null;
      const end = offset + 12 + length;
      const type = buffer.toString('ascii', offset + 4, offset + 8);
      if (!/^[A-Za-z]{4}$/.test(type)) return null;
      const storedCrc = buffer.readUInt32BE(offset + 8 + length);
      if (pngCrc32(buffer.subarray(offset + 4, offset + 8 + length)) !== storedCrc) return null;
      if (!sawHeader) {
        if (type !== 'IHDR' || length !== 13) return null;
        width = buffer.readUInt32BE(offset + 8); height = buffer.readUInt32BE(offset + 12); sawHeader = true;
      } else if (type === 'IHDR') return null;
      if (type === 'IDAT') {
        if (idatClosed) return null;
        sawData = true;
      } else if (sawData && type !== 'IEND') idatClosed = true;
      if (type === 'IEND') return length === 0 && sawData && end === buffer.length ? { format: 'png', width, height } : null;
      offset = end;
    }
    return null;
  }
  if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[buffer.length - 2] === 0xff && buffer[buffer.length - 1] === 0xd9) {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      while (offset < buffer.length && buffer[offset] === 0xff) offset++;
      if (offset >= buffer.length) break;
      const marker = buffer[offset++];
      if (marker === 0xd9 || marker === 0xda) break;
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > buffer.length) break;
      const length = buffer.readUInt16BE(offset);
      if (length < 2 || offset + length > buffer.length) break;
      const sof = (marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf);
      if (sof && length >= 7) return { format: 'jpeg', width: buffer.readUInt16BE(offset + 5), height: buffer.readUInt16BE(offset + 3) };
      offset += length;
    }
  }
  if (buffer.length >= 20 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
    const riffEnd = buffer.readUInt32LE(4) + 8;
    if (riffEnd < 20 || riffEnd !== buffer.length) return null;
    let offset = 12; let width = 0; let height = 0; let sawExtended = false; let sawImageData = false;
    while (offset < riffEnd) {
      if (offset + 8 > riffEnd) return null;
      const tag = buffer.toString('ascii', offset, offset + 4);
      const chunkLength = buffer.readUInt32LE(offset + 4);
      const data = offset + 8;
      const chunkEnd = data + chunkLength;
      const paddedEnd = chunkEnd + (chunkLength & 1);
      if (chunkEnd > riffEnd || paddedEnd > riffEnd) return null;
      if (tag === 'VP8X') {
        if (chunkLength !== 10 || sawExtended || sawImageData) return null;
        width = 1 + buffer[data + 4] + (buffer[data + 5] << 8) + (buffer[data + 6] << 16);
        height = 1 + buffer[data + 7] + (buffer[data + 8] << 8) + (buffer[data + 9] << 16);
        sawExtended = true;
      } else if (tag === 'VP8 ' && chunkLength >= 10 && buffer[data + 3] === 0x9d && buffer[data + 4] === 0x01 && buffer[data + 5] === 0x2a) {
        if (sawImageData) return null;
        const dataWidth = buffer.readUInt16LE(data + 6) & 0x3fff;
        const dataHeight = buffer.readUInt16LE(data + 8) & 0x3fff;
        if ((width && width !== dataWidth) || (height && height !== dataHeight)) return null;
        width = dataWidth; height = dataHeight; sawImageData = true;
      } else if (tag === 'VP8L' && chunkLength >= 5 && buffer[data] === 0x2f) {
        if (sawImageData) return null;
        const b1 = buffer[data + 1], b2 = buffer[data + 2], b3 = buffer[data + 3], b4 = buffer[data + 4];
        if ((b4 >>> 5) !== 0) return null;
        const dataWidth = 1 + b1 + ((b2 & 0x3f) << 8);
        const dataHeight = 1 + (b2 >>> 6) + (b3 << 2) + ((b4 & 0x0f) << 10);
        if ((width && width !== dataWidth) || (height && height !== dataHeight)) return null;
        width = dataWidth; height = dataHeight; sawImageData = true;
      }
      offset = paddedEnd;
    }
    if (sawImageData && width > 0 && height > 0 && offset === riffEnd) return { format: 'webp', width, height };
  }
  return null;
}
async function readImage(req, cap = MAX_IMAGE_BYTES) {
  const reject = (status, message) => { req.resume(); throw Object.assign(new Error(message), { status }); };
  const contentType = String(req.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
  if (!['image/jpeg', 'image/png', 'image/webp', 'application/octet-stream'].includes(contentType)) reject(415, '只接受 JPEG、PNG 或 WebP 截图。');
  const declaredLength = Number(req.headers['content-length']);
  if (Number.isFinite(declaredLength) && declaredLength > cap) reject(413, '图片过大，请降低截图分辨率后重试。');
  const chunks = []; let len = 0; let oversized = false;
  for await (const chunk of req) {
    len += chunk.length;
    if (len > cap) { oversized = true; continue; }
    chunks.push(chunk);
  }
  if (oversized) throw Object.assign(new Error('图片过大，请降低截图分辨率后重试。'), { status: 413 });
  if (!len) throw Object.assign(new Error('未收到截图数据。'), { status: 400 });
  const image = Buffer.concat(chunks); const dimensions = imageDimensions(image);
  if (!dimensions || !Number.isInteger(dimensions.width) || !Number.isInteger(dimensions.height) || dimensions.width < 64 || dimensions.height < 64 || dimensions.width * dimensions.height > 20_000_000) throw Object.assign(new Error('截图格式或尺寸无效。'), { status: 415 });
  const expectedFormat = { 'image/png': 'png', 'image/jpeg': 'jpeg', 'image/webp': 'webp' }[contentType];
  if (expectedFormat && expectedFormat !== dimensions.format) throw Object.assign(new Error('截图内容与声明的图片格式不匹配。'), { status: 415 });
  return image;
}
function cleanLogin(value) {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  const urlMatch = /^https:\/\/(?:www\.)?twitch\.tv\/([a-z0-9_]{1,25})\/?$/i.exec(text);
  const login = (urlMatch ? urlMatch[1] : text.replace(/^@/, '')).toLowerCase();
  const reserved = new Set(['login','signup','activate','settings','subscriptions','directory','search','downloads','privacy','p','videos','clip','clips']);
  return /^[a-z0-9_]{1,25}$/.test(login) && !reserved.has(login) ? login : '';
}
function reportKey(login, found) { return `${login}/${found.activityCode}/${found.encounterCode}/${found.difficultyCode}`; }
function reportFresh(report) { return Boolean(report && Date.now() - Date.parse(report.observedAt || 0) < REPORT_TTL_MS); }
function ensureChannel(login, protectedChannels = settings.watchedChannels) {
  let channel = channels.get(login);
  if (channel) return channel;
  if (channels.size >= 100) {
    const removable = [...channels.values()].filter(item => !protectedChannels.includes(item.login))
      .sort((a, b) => Date.parse(a.lastFrameAt || 0) - Date.parse(b.lastFrameAt || 0))[0];
    if (!removable) throw Object.assign(new Error('本机最多保存 100 个频道观察，请先减少已添加频道。'), { status: 429 });
    channels.delete(removable.login);
    reports = reports.filter(report => report.login !== removable.login);
    queueObservations.delete(removable.login);
    for (const key of recognizedFrames.keys()) if (key.startsWith(`${removable.login}/`)) recognizedFrames.delete(key);
  }
  channel = { login, displayName: login, lastFrameAt: null, queueLength: null, lastFingerprint: null, previousKeys: new Set() };
  channels.set(login, channel);
  return channel;
}
function estimateFor(login, queueLength) {
  const observations = (queueObservations.get(login) || []).filter(item => Date.now() - item.at < 30 * 60_000 && Number.isFinite(item.queueLength));
  let perMinute = 0;
  if (observations.length >= 3) {
    const drops = [];
    for (let i = 1; i < observations.length; i++) {
      const a = observations[i - 1], b = observations[i], minutes = (b.at - a.at) / 60_000;
      if (minutes >= 0.25 && minutes <= 30 && a.queueLength > b.queueLength) drops.push((a.queueLength - b.queueLength) / minutes);
    }
    if (drops.length >= 2) perMinute = drops.sort((a, b) => a - b)[Math.floor(drops.length / 2)];
  }
  return { queueLength: Number.isFinite(queueLength) ? queueLength : null, completionRatePerMinute: perMinute ? Number(perMinute.toFixed(2)) : null,
    estimatedMinutes: perMinute > 0 && Number.isFinite(queueLength) ? Math.ceil(queueLength / perMinute) : null,
    confidence: perMinute > 0 ? '依据本机多次识别到的队列变化估算，仅供参考' : '本机观测样本不足，暂不估时' };
}
function summarizeChannel(channel) {
  const age = channel.lastFrameAt ? Date.now() - Date.parse(channel.lastFrameAt) : Infinity;
  const currentReports = reports.filter(report => report.login === channel.login && reportFresh(report));
  return { login: channel.login, displayName: channel.displayName || channel.login, lastFrameAt: channel.lastFrameAt,
    queueLength: Number.isFinite(channel.queueLength) ? channel.queueLength : null,
    watching: age < 2 * 60_000, frameAgeSeconds: Number.isFinite(age) ? Math.max(0, Math.round(age / 1000)) : null,
    reports: currentReports.slice(-20), estimate: estimateFor(channel.login, channel.queueLength),
    url: `https://www.twitch.tv/${encodeURIComponent(channel.login)}` };
}
function rankRecommendations() {
  return reports.filter(report => {
    const channel = channels.get(report.login);
    return report.status === 'available' && reportFresh(report) && channel?.lastFrameAt && Date.now() - Date.parse(channel.lastFrameAt) < REPORT_TTL_MS;
  }).map(report => {
    const channel = channels.get(report.login); const estimate = estimateFor(report.login, channel?.queueLength);
    return { report, login: report.login, displayName: channel?.displayName || report.displayName || report.login,
      queueLength: estimate.queueLength, estimatedMinutes: estimate.estimatedMinutes, confidence: estimate.confidence };
  }).sort((a, b) => (a.estimatedMinutes ?? Infinity) - (b.estimatedMinutes ?? Infinity) || (a.queueLength ?? Infinity) - (b.queueLength ?? Infinity));
}
function buildState() {
  const now = Date.now();
  const recentReports = reports.filter(reportFresh).map(report => {
    const channel = channels.get(report.login);
    const current = channel?.lastFrameAt && now - Date.parse(channel.lastFrameAt) < REPORT_TTL_MS;
    return !current && report.status === 'available' ? { ...report, status: 'candidate', confidence: '本频道近期没有新截图，需重新确认' } : report;
  });
  return { app: { state: lastError ? 'error' : 'ready', message: lastError || '准备就绪：打开 Twitch 网页后点击“识别当前画面”', error: lastError, lastScanAt },
    settings, streams: [...channels.values()].map(summarizeChannel).sort((a, b) => Number(b.watching) - Number(a.watching) || (b.lastFrameAt || '').localeCompare(a.lastFrameAt || '')),
    reports: recentReports.slice(-500).reverse(), recommendations: rankRecommendations().slice(0, 12),
    capabilities: { embeddedTwitchWeb: true, localScreenRecognition: process.platform === 'win32', twitchDeveloperAppRequired: false, chatSending: false },
    limitations: ['程序只识别你在 Twitch 官方网页中实际打开的可见画面，不扫描 Twitch 直播目录。', '识别使用本机截图 OCR；网页画面清晰度、缩略图/视频加载及 Twitch 播放状态会影响结果。', '连续两张不同画面识别到相同进度后才标为已复核候选；OCR 仍可能误读，请在 Twitch 页面人工核对。', '队列估时只根据本机多次看到的队列变化计算；样本不足时显示未知。', '账号网页登录遵循 Twitch 自身安全验证；本程序不读取密码或 Cookie，也不绕过账号安全验证。'] };
}
async function scanScreen(loginValue, image) {
  const login = cleanLogin(loginValue);
  if (!login) throw Object.assign(new Error('无法识别 Twitch 频道名称。请从频道页面打开识别窗口。'), { status: 400 });
  if (activeScans.size >= 1) throw Object.assign(new Error('已有画面正在识别，请稍候。'), { status: 429 });
  activeScans.add(login);
  try {
    const fingerprint = crypto.createHash('sha256').update(image).digest('hex');
    const channel = ensureChannel(login);
  if (channel.lastFingerprint === fingerprint) return { login, duplicate: true, recognized: false, reports: reports.filter(report => report.login === login && reportFresh(report)), message: '画面没有变化；等待播放画面更新后再识别。' };
  const result = await recognizeImage(image, { channel: login, isScreenshot: true });
  const observedAt = new Date().toISOString(); const now = Date.now();
  channel.lastFingerprint = fingerprint; channel.lastFrameAt = observedAt; channel.watching = true;
  channel.queueLength = Number.isFinite(result?.queueLength) ? result.queueLength : null;
  if (Number.isFinite(channel.queueLength)) {
    const history = queueObservations.get(login) || []; history.push({ at: now, queueLength: channel.queueLength }); queueObservations.set(login, history.slice(-30));
  }
  const nextKeys = new Set();
  if (result?.recognized) {
    for (const found of result.reports || []) {
      const key = reportKey(login, found); nextKeys.add(key);
      const prior = recognizedFrames.get(key);
      const distinctConsecutive = prior && prior.fingerprint !== fingerprint && channel.previousKeys.has(key) && now - prior.at < FRAME_CONFIRM_TTL_MS;
      recognizedFrames.set(key, { fingerprint, at: now });
      const existing = reports.find(report => report.login === login && reportKey(login, report) === key);
      const record = { id: existing?.id || crypto.randomUUID(), login, displayName: channel.displayName || login,
        activity: found.activity, activityCode: found.activityCode, encounter: found.encounter, encounterCode: found.encounterCode,
        difficulty: found.difficulty, difficultyCode: found.difficultyCode, queueLength: channel.queueLength,
        confidence: distinctConsecutive ? '连续识别两张不同画面' : '单张画面候选，请复核', status: distinctConsecutive ? 'available' : 'candidate', observedAt, source: 'Twitch网页可见画面' };
      if (existing) Object.assign(existing, record); else reports.push(record);
    }
  }
  for (const oldKey of channel.previousKeys) if (!nextKeys.has(oldKey)) {
    recognizedFrames.delete(oldKey);
    const existing = reports.find(report => report.login === login && reportKey(login, report) === oldKey);
    if (existing) existing.status = 'candidate';
  }
  channel.previousKeys = nextKeys;
  if (!result?.recognized) {
    for (const report of reports) if (report.login === login) { report.status = 'candidate'; report.confidence = '本次画面未识别到该进度'; }
    for (const key of recognizedFrames.keys()) if (key.startsWith(`${login}/`)) recognizedFrames.delete(key);
    channel.previousKeys.clear();
  }
  channels.set(login, channel);
  reports = reports.filter(report => now - Date.parse(report.observedAt || 0) < REPORT_TTL_MS).slice(-500);
  lastScanAt = observedAt; lastError = '';
  await persist();
  const payload = { login, duplicate: false, recognized: Boolean(result?.recognized), queueLength: channel.queueLength,
    reports: reports.filter(report => report.login === login && reportFresh(report)), result };
  // State persisted locally; dashboard reads it on demand.
  return payload;
  } finally {
    activeScans.delete(login);
  }
}
function makeServer() {
  return http.createServer(async (req, res) => {
    let url; try { url = new URL(req.url || '/', `http://${HOST}`); } catch { req.resume(); sendJson(res, 400, { error: '请求地址无效。' }); return; }
    const bootstrap = req.method === 'GET' && url.pathname === '/' && consumeLaunchKey(req);
    if (bootstrap) {
      const sid = crypto.randomBytes(32).toString('base64url'); sessionId = sid;
      res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Set-Cookie': `d2sid=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400` });
      res.end(fs.readFileSync(path.join(UI_ROOT, 'index.html'))); return;
    }
    if (!authenticated(req)) { req.resume(); sendJson(res, 401, { error: '本机应用会话无效，请重新启动应用。' }, { 'X-D2-Session': 'required' }); return; }
    if (req.method !== 'GET' && !originOkay(req)) { req.resume(); sendJson(res, 403, { error: '请求来源校验失败。' }); return; }
    try {
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) { reply(res, 200, fs.readFileSync(path.join(UI_ROOT, 'index.html')), { 'Content-Type': MIME['.html'] }); return; }
      if (req.method === 'GET' && url.pathname.startsWith('/ui/')) {
        const name = url.pathname.slice(4); if (!['app.js', 'styles.css'].includes(name)) { reply(res, 404, '未找到请求资源。', { 'Content-Type': 'text/plain; charset=utf-8' }); return; }
        reply(res, 200, fs.readFileSync(path.join(UI_ROOT, name)), { 'Content-Type': MIME[path.extname(name)] }); return;
      }
      if (req.method === 'GET' && url.pathname === '/api/state') { sendJson(res, 200, buildState()); return; }
      if (req.method === 'POST' && url.pathname === '/api/screen-scan') {
        const login = cleanLogin(url.searchParams.get('login'));
        if (!login) { req.resume(); sendJson(res, 400, { error: '请从 Twitch 频道网页启动画面识别。' }); return; }
        const result = await withImageJob(req, async () => scanScreen(login, await readImage(req)));
        sendJson(res, 200, result); return;
      }
      if (req.method === 'POST' && url.pathname === '/api/watch') {
        const body = await readBody(req, 8000); const login = cleanLogin(body.login);
        if (!login) { sendJson(res, 400, { error: '请输入有效的 Twitch 频道登录名。' }); return; }
        const nextWatched = [...new Set([...settings.watchedChannels, login])].slice(-100);
        ensureChannel(login, nextWatched);
        settings.watchedChannels = nextWatched;
        await persist(); sendJson(res, 200, { login, url: `https://www.twitch.tv/${encodeURIComponent(login)}` }); return;
      }
      if (req.method === 'POST' && url.pathname === '/api/image-test') {
        const result = await withImageJob(req, async () => recognizeImage(await readImage(req), { isScreenshot: true })); sendJson(res, 200, result); return;
      }
      if (req.method === 'GET') { reply(res, 404, '未找到请求资源。', { 'Content-Type': 'text/plain; charset=utf-8' }); return; }
      reply(res, 405, '不支持的请求方法。', { 'Content-Type': 'text/plain; charset=utf-8', 'Allow': 'GET, POST' });
    } catch (error) {
      const safeStatus = Number.isInteger(error.status) && error.status >= 400 && error.status < 500 ? error.status : 500;
      const safeMessage = safeStatus === 500 ? '本机处理失败。未记录或返回截图文本；请重试或重启应用。' : String(error.message || '请求失败。').slice(0, 180);
      lastError = safeStatus === 500 ? safeMessage : '';
      sendJson(res, safeStatus, { error: safeMessage });
    }
  });
}
const server = makeServer(); server.requestTimeout = 30_000; server.headersTimeout = 10_000;
if (require.main === module) {
  server.listen(PORT, HOST, () => { const address = server.address(); process.stdout.write(`${process.env.D2_PORT === '0' ? 'D2_READY' : '本机服务已启动'} http://${HOST}:${address.port}/\n`); });
  process.on('SIGINT', () => server.close(() => process.exit(0)));
  process.on('SIGTERM', () => server.close(() => process.exit(0)));
}
module.exports = { makeServer, scanScreen, buildState, estimateFor, persist };
