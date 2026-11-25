'use strict';

const IDENTITY = 'https://id.twitch.tv/oauth2';
const HELIX = 'https://api.twitch.tv/helix';
const SCOPE = 'user:write:chat';
const THUMBNAIL_LIMIT = 6 * 1024 * 1024;
const VALIDATE_INTERVAL = 59 * 60_000;

function twitchError(status, message) {
  return Object.assign(new Error(message), { status });
}

function normalizeLogin(value) {
  const login = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!/^[a-z0-9_]{1,25}$/.test(login)) throw twitchError(400, 'Twitch 频道登录名无效。');
  return login;
}

function validateClientId(value) {
  return typeof value === 'string' && /^[a-z0-9]{8,80}$/i.test(value);
}

function authorizationUrl(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (url.origin === 'https://www.twitch.tv' && url.pathname === '/activate' && !url.username && !url.password) return url.href;
  } catch { }
  return null;
}

function listResponse(data) {
  if (!Array.isArray(data?.data)) throw twitchError(502, 'Twitch 返回的数据格式无效。');
  return data.data;
}

const chatRejections = {
  msg_duplicate: 'Twitch 已拦截近期重复发送的指令。',
  user_banned: '当前 Twitch 账号在该频道无法发言。',
  user_warned: '请到 Twitch 聊天区确认频道警告后再试。',
  user_timed_out: '当前 Twitch 账号在该频道暂时禁言。',
  emote_only_mode: '该频道当前只允许发送表情。',
  followers_only_mode: '该频道要求满足关注条件后才能发言。',
  subs_only_mode: '该频道当前仅允许订阅者发言。',
  unique_mode: '该频道当前会拦截重复聊天消息。',
  verified_account: '请在 Twitch 完成账号验证后再试。',
  verified_phone_number: '该频道要求先在 Twitch 验证手机号。',
  automod_held: 'Twitch 已将指令送交审核，请暂勿重复申请。',
  channel_suspended: '该 Twitch 频道目前不可用。'
};

function createTwitchClient({ clientId = process.env.D2_TWITCH_CLIENT_ID, fetchImpl = globalThis.fetch } = {}) {
  const initialId = typeof clientId === 'string' ? clientId.trim() : '';
  let configuredId = validateClientId(initialId) ? initialId : null;
  let device = null;
  let session = null;
  let starting = null;
  let checking = null;
  let refreshing = null;
  let validationTimer = null;
  let generation = 0;
  let sending = false;
  let lastMessage = null;

  function status() {
    const result = { configured: !!configuredId, connected: !!session, login: session?.login || null };
    if (configuredId) result.clientId = configuredId;
    if (device) {
      const { userCode, verificationUri, expiresAt, interval } = device;
      result.device = { userCode, verificationUri, expiresAt, interval };
    }
    return result;
  }

  function disconnect() {
    generation++;
    device = session = starting = checking = refreshing = null;
    lastMessage = null;
    clearTimeout(validationTimer);
    validationTimer = null;
    return status();
  }

  async function request(url, options, forSending = false) {
    try {
      return await fetchImpl(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(10_000) });
    } catch (error) {
      if (forSending) throw twitchError(502, 'Twitch 连接中断，发送结果未知。请先查看聊天记录再决定是否重试。');
      if (error?.name === 'TimeoutError' || error?.name === 'AbortError') throw twitchError(504, 'Twitch 请求超时，请稍后再试。');
      throw twitchError(502, '无法连接 Twitch，请检查网络后重试。');
    }
  }

  async function readJson(response, forSending = false) {
    try {
      return await response.json();
    } catch {
      if (forSending) throw twitchError(502, '无法确认发送结果，请先查看 Twitch 聊天记录。');
      throw twitchError(502, 'Twitch 返回的数据格式无效。');
    }
  }

  function form(path, fields) {
    return request(`${IDENTITY}/${path}`, { method: 'POST', body: new URLSearchParams(fields) });
  }

  function requireCurrent(expectedGeneration) {
    if (expectedGeneration !== generation) throw twitchError(409, 'Twitch 授权已更改，请重试。');
  }

  async function loadDevice(id, attempt) {
    const response = await form('device', { client_id: id, scopes: SCOPE });
    if (!response.ok) {
      if (response.status === 429) throw rateLimitError(response);
      if (response.status < 500) throw twitchError(400, 'Twitch 无法启动授权，请确认 Client ID 对应公共客户端。');
      throw twitchError(502, 'Twitch 授权服务暂时不可用。');
    }
    const data = await readJson(response);
    const verificationUri = authorizationUrl(data?.verification_uri);
    const expiresIn = Number(data?.expires_in);
    if (!verificationUri || typeof data?.device_code !== 'string' || !data.device_code ||
        typeof data?.user_code !== 'string' || !data.user_code || !Number.isFinite(expiresIn) || expiresIn <= 0) {
      throw twitchError(502, 'Twitch 返回了无效的设备授权信息。');
    }
    requireCurrent(attempt);
    const interval = Math.max(5, Number(data.interval) || 5);
    const now = Date.now();
    device = { code: data.device_code, userCode: data.user_code, verificationUri, expiresAt: now + expiresIn * 1000,
      interval, pollAt: now + interval * 1000 };
    return status();
  }

  async function startDevice(nextClientId) {
    const id = nextClientId === undefined ? configuredId : typeof nextClientId === 'string' ? nextClientId.trim() : null;
    if (!validateClientId(id)) throw twitchError(400, '请输入本程序注册的 Twitch 公共 Client ID。');
    if (configuredId === id) {
      if (starting) return starting;
      if (checking) return checking;
      if (session || (device && device.expiresAt > Date.now())) return status();
    }
    disconnect();
    configuredId = id;
    const attempt = loadDevice(id, generation);
    starting = attempt;
    try { return await attempt; } finally { if (starting === attempt) starting = null; }
  }

  async function validateToken(id, accessToken) {
    const response = await request(`${IDENTITY}/validate`, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (response.status === 401) throw twitchError(401, 'Twitch 授权已失效，请重新连接。');
    if (response.status === 429) throw rateLimitError(response);
    if (!response.ok) throw twitchError(502, '暂时无法验证 Twitch 授权。');
    const data = await readJson(response);
    if (data?.client_id !== id || !Array.isArray(data.scopes) || !data.scopes.includes(SCOPE) ||
        typeof data.user_id !== 'string' || !/^\d+$/.test(data.user_id) || typeof data.login !== 'string' ||
        !Number.isFinite(data.expires_in) || data.expires_in <= 0) {
      throw twitchError(403, 'Twitch 授权没有授予本程序发送聊天消息的权限，请重新连接。');
    }
    return data;
  }

  function rateLimitError(response) {
    const reset = Number(response.headers.get('Ratelimit-Reset'));
    const wait = Math.ceil(reset - Date.now() / 1000);
    return twitchError(429, wait > 0 ? `Twitch 暂时限流，请在 ${wait} 秒后重试。` : 'Twitch 暂时限流，请稍后再试。');
  }

  function scheduleValidation(delay = VALIDATE_INTERVAL) {
    clearTimeout(validationTimer);
    if (!session) return;
    validationTimer = setTimeout(async () => {
      try { await ensureSession(true); } catch { scheduleValidation(60_000); }
    }, delay);
    validationTimer.unref();
  }

  async function connectToken(data, id, attempt) {
    requireCurrent(attempt);
    if (typeof data?.access_token !== 'string' || !data.access_token) throw twitchError(502, 'Twitch 返回了无效的授权凭据。');
    const identity = await validateToken(id, data.access_token);
    requireCurrent(attempt);
    session = { clientId: id, accessToken: data.access_token, refreshToken: data.refresh_token,
      login: identity.login, userId: identity.user_id, expiry: Date.now() + identity.expires_in * 1000, generation: attempt };
    scheduleValidation();
    return session;
  }

  async function pollDevice(current, id, attempt) {
    if (!current.token) {
      const response = await form('token', { client_id: id, scopes: SCOPE, device_code: current.code,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code' });
      requireCurrent(attempt);
      if (response.status === 429) throw rateLimitError(response);
      if (response.status >= 500) throw twitchError(502, 'Twitch 授权服务暂时不可用。');
      const data = await readJson(response);
      requireCurrent(attempt);
      if (!response.ok) {
        const reason = data?.message || data?.error;
        if (reason === 'authorization_pending') return status();
        if (reason === 'slow_down') {
          current.interval += 5;
          return status();
        }
        device = null;
        throw twitchError(410, 'Twitch 设备授权已失效或被取消，请重新连接。');
      }
      current.token = data;
    }
    try {
      await connectToken(current.token, id, attempt);
    } catch (error) {
      if (device === current && (error.status === 401 || error.status === 403)) device = null;
      throw error;
    }
    if (device === current) device = null;
    return status();
  }

  async function checkDevice() {
    if (checking) return checking;
    if (!device) return status();
    if (Date.now() >= device.expiresAt) {
      device = null;
      throw twitchError(410, 'Twitch 设备授权码已过期，请重新连接。');
    }
    if (Date.now() < device.pollAt) return status();
    const current = device;
    const attempt = pollDevice(current, configuredId, generation);
    checking = attempt;
    try { return await attempt; } finally {
      current.pollAt = Date.now() + current.interval * 1000;
      if (checking === attempt) checking = null;
    }
  }

  async function updateSession(current, revalidate) {
    try {
      if (Date.now() + 60_000 < current.expiry) {
        if (revalidate) {
          const identity = await validateToken(current.clientId, current.accessToken);
          requireCurrent(current.generation);
          current.expiry = Date.now() + identity.expires_in * 1000;
          scheduleValidation();
        }
        return current;
      }
      if (typeof current.refreshToken !== 'string' || !current.refreshToken) throw twitchError(401, 'Twitch 授权已过期，请重新连接。');
      const response = await form('token', { client_id: current.clientId, refresh_token: current.refreshToken, grant_type: 'refresh_token' });
      if (response.status === 400 || response.status === 401) throw twitchError(401, 'Twitch 授权已失效，请重新连接。');
      if (response.status === 429) throw rateLimitError(response);
      if (!response.ok) throw twitchError(502, '暂时无法续期 Twitch 授权。');
      return await connectToken(await readJson(response), current.clientId, current.generation);
    } catch (error) {
      if (session === current && (error.status === 401 || error.status === 403)) disconnect();
      throw error;
    }
  }

  async function ensureSession(revalidate = false) {
    if (!session) throw twitchError(401, '请先连接并授权 Twitch 账号。');
    if (refreshing) return refreshing;
    const attempt = updateSession(session, revalidate);
    refreshing = attempt;
    try { return await attempt; } finally { if (refreshing === attempt) refreshing = null; }
  }

  async function api(path, active, body) {
    requireCurrent(active.generation);
    const headers = { Authorization: `Bearer ${active.accessToken}`, 'Client-Id': active.clientId };
    const options = body ? { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : { headers };
    const response = await request(`${HELIX}${path}`, options, !!body);
    if (response.status === 401) {
      if (session === active) disconnect();
      throw twitchError(401, 'Twitch 授权已失效，请重新连接。');
    }
    if (response.status === 403) throw twitchError(403, '当前 Twitch 账号对此频道没有操作权限。');
    if (response.status === 429) throw rateLimitError(response);
    if (response.status >= 500 && body) throw twitchError(502, 'Twitch 发送结果未知，请先查看聊天记录。');
    if (!response.ok) throw twitchError(502, `Twitch 请求失败（HTTP ${response.status}）。`);
    return readJson(response, !!body);
  }

  async function getStreams(logins) {
    if (!Array.isArray(logins)) throw twitchError(400, 'Twitch 频道列表无效。');
    const unique = [...new Set(logins.map(normalizeLogin))];
    if (unique.length === 0) return [];
    if (unique.length > 100) throw twitchError(400, '每次最多查询 100 个 Twitch 频道。');
    const search = new URLSearchParams({ first: String(unique.length) });
    for (const login of unique) search.append('user_login', login);
    const active = await ensureSession();
    return listResponse(await api(`/streams?${search}`, active));
  }

  async function getThumbnail(stream) {
    const template = stream?.thumbnail_url;
    let thumbnail;
    try { if (typeof template === 'string') thumbnail = new URL(template.replace('{width}x{height}', '1920x1080')); } catch { }
    if (thumbnail?.origin !== 'https://static-cdn.jtvnw.net' || thumbnail.username || thumbnail.password ||
        thumbnail.search || thumbnail.hash || !/^\/previews-ttv\/live_user_[a-z0-9_]+-\d+x\d+\.jpg$/i.test(thumbnail.pathname)) {
      throw twitchError(502, 'Twitch 提供的直播缩略图地址无效。');
    }
    const response = await request(thumbnail.href);
    if (!response.ok) throw twitchError(502, '无法取得 Twitch 直播缩略图。');
    const type = response.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase();
    const size = Number(response.headers.get('Content-Length'));
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(type) || size > THUMBNAIL_LIMIT || !response.body) {
      await response.body?.cancel().catch(() => {});
      throw twitchError(502, 'Twitch 直播缩略图格式无效或超过大小限制。');
    }
    const chunks = [];
    let total = 0;
    try {
      for await (const chunk of response.body) {
        total += chunk.length;
        if (total > THUMBNAIL_LIMIT) throw twitchError(502, 'Twitch 直播缩略图超过大小限制。');
        chunks.push(chunk);
      }
    } catch (error) {
      if (error.status) throw error;
      throw twitchError(502, '读取 Twitch 直播缩略图失败。');
    }
    if (total === 0) throw twitchError(502, 'Twitch 返回了空的直播缩略图。');
    return Buffer.concat(chunks, total);
  }

  async function sendChat(login, message) {
    const channel = normalizeLogin(login);
    if (typeof message !== 'string' || !message.trim() || /[\r\n\u0000-\u001F\u007F]/.test(message) || [...message].length > 500) {
      throw twitchError(400, '聊天指令格式无效。');
    }
    if (sending) throw twitchError(409, '已有一条聊天指令正在发送，请稍候。');
    if (lastMessage?.channel === channel && lastMessage.message === message && Date.now() - lastMessage.at < 30_000) {
      throw twitchError(429, '请等待 30 秒后再向该频道发送相同指令。');
    }
    sending = true;
    try {
      const active = await ensureSession();
      const target = listResponse(await api(`/users?${new URLSearchParams({ login: channel })}`, active))
        .find(user => user?.login === channel && typeof user.id === 'string' && /^\d+$/.test(user.id));
      if (!target) throw twitchError(404, '找不到该 Twitch 频道。');
      const shared = listResponse(await api(`/shared_chat/session?${new URLSearchParams({ broadcaster_id: target.id })}`, active));
      if (shared.length) throw twitchError(409, '该频道开启了共享聊天，请手动在频道内发出指令。');
      const body = { broadcaster_id: target.id, sender_id: active.userId, message };
      lastMessage = { channel, message, at: Date.now() };
      const [outcome] = listResponse(await api('/chat/messages', active, body));
      if (outcome?.is_sent === true && typeof outcome.message_id === 'string' && outcome.message_id) return outcome.message_id;
      if (outcome?.is_sent !== false) throw twitchError(502, '无法确认发送结果，请先查看 Twitch 聊天记录。');
      const code = outcome.drop_reason?.code;
      if (code === 'slow_mode') throw twitchError(429, '该频道开启了慢速聊天，请等待后重试。');
      throw twitchError(409, Object.hasOwn(chatRejections, code) ? chatRejections[code] : 'Twitch 或频道规则拦截了这条指令。');
    } finally { sending = false; }
  }

  return { status, startDevice, checkDevice, disconnect, getStreams, getThumbnail, sendChat };
}

module.exports = { createTwitchClient };
