'use strict';

const model = {
  state: null,
  currentLogin: '',
  toastTimer: null,
  lastRequestId: null,
  scanBusy: false
};
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
const $ = id => document.getElementById(id);
const ui = {
  monitorStatus: $('monitor-status'), watchingCount: $('watching-count'), reportCount: $('report-count'), channelTotal: $('channel-total'),
  sideChannels: $('side-channels'), metricWatching: $('metric-watching'), metricReports: $('metric-reports'), metricScan: $('metric-scan'),
  refresh: $('refresh'), channelLogin: $('channel-login'), openTwitch: $('open-twitch'), activeChannelLabel: $('active-channel-label'),
  pageState: $('page-state'), recognitionStatus: $('recognition-status'), reportList: $('report-list'), resultCount: $('result-count'), recommendationList: $('recommendation-list'),
  channelList: $('channel-list'), watchedCount: $('watched-count'), imageFile: $('image-file'), imageTest: $('image-test'),
  manualResult: $('manual-result'), toast: $('toast')
};

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>\'"]/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' }[c]));
}
function toast(message, kind = '') {
  if (!ui.toast) return;
  ui.toast.textContent = message;
  ui.toast.className = `toast show ${kind}`;
  clearTimeout(model.toastTimer);
  model.toastTimer = setTimeout(() => { ui.toast.className = 'toast'; }, 4200);
}
function validLogin(value) {
  const login = String(value ?? '').trim().replace(/^@/, '').toLowerCase();
  const reserved = new Set(['login', 'signup', 'activate', 'settings', 'subscriptions', 'directory', 'search', 'downloads', 'privacy', 'p', 'videos', 'clip', 'clips']);
  return /^[a-z0-9_]{1,25}$/.test(login) && !reserved.has(login) ? login : '';
}
function webviewBridge() {
  const bridge = window.chrome?.webview;
  return bridge && typeof bridge.postMessage === 'function' ? bridge : null;
}
async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'same-origin',
    ...options,
    headers: { ...(options.headers || {}) }
  });
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { error: text }; }
  if (!response.ok) throw Object.assign(new Error(data?.error || `请求失败（${response.status}）`), { status: response.status, data });
  return data;
}
function fmtTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' });
}
function reportLabel(report) {
  return `${report.activity || report.activityCode || '未知副本'} · ${report.encounter || report.encounterCode || '未知关卡'}${report.difficulty ? ` · ${report.difficulty}` : ''}`;
}
function isWatching(channel) {
  if (typeof channel?.watching === 'boolean') return channel.watching;
  if (channel?.lastFrameAt) return Date.now() - Date.parse(channel.lastFrameAt) < 3 * 60_000;
  return false;
}
function getChannels() { return Array.isArray(model.state?.streams) ? model.state.streams : []; }
function getReports() { return Array.isArray(model.state?.reports) ? model.state.reports : []; }
function getCurrentChannel() { return getChannels().find(channel => channel.login === model.currentLogin) || null; }
function selectedChannelList() {
  const watched = Array.isArray(model.state?.settings?.watchedChannels) ? model.state.settings.watchedChannels : [];
  const map = new Map();
  for (const loginValue of watched) {
    const login = validLogin(loginValue);
    if (login) map.set(login, getChannels().find(channel => channel.login === login) || { login, displayName: login, watching: false, reports: [], queueLength: null, estimate: null });
  }
  for (const channel of getChannels()) if (!map.has(channel.login)) map.set(channel.login, channel);
  return [...map.values()];
}

function renderState() {
  if (!model.state) return;
  const channels = selectedChannelList();
  const watching = channels.filter(isWatching);
  const reports = getReports();
  if (ui.watchingCount) ui.watchingCount.textContent = String(watching.length);
  if (ui.metricWatching) ui.metricWatching.textContent = String(watching.length);
  if (ui.reportCount) ui.reportCount.textContent = String(reports.length);
  if (ui.metricReports) ui.metricReports.textContent = String(reports.length);
  if (ui.channelTotal) ui.channelTotal.textContent = String(channels.length);
  if (ui.watchedCount) ui.watchedCount.textContent = String(channels.length);
  if (ui.metricScan) ui.metricScan.textContent = fmtTime(model.state.app?.lastScanAt);
  if (ui.monitorStatus) {
    const status = model.state.app || {};
    ui.monitorStatus.className = `monitor-state ${status.state === 'error' ? 'error' : status.state === 'ready' ? 'active' : ''}`;
    ui.monitorStatus.innerHTML = `<i></i><span>${escapeHtml(status.message || '等待桌面窗口画面')}</span>`;
  }
  renderSideChannels(channels);
  renderWatchedChannels(channels);
  renderReports(reports);
  renderRecommendations(model.state.recommendations);
  renderCurrentChannel();
}
function renderSideChannels(channels) {
  if (!ui.sideChannels) return;
  if (!channels.length) {
    ui.sideChannels.innerHTML = '<div class="empty-mini">输入 Twitch 频道登录名开始</div>';
    return;
  }
  ui.sideChannels.innerHTML = channels.slice(0, 14).map(channel => `<button class="side-channel ${channel.login === model.currentLogin ? 'selected' : ''}" data-select-login="${escapeHtml(channel.login)}"><span class="channel-dot ${isWatching(channel) ? 'online' : ''}"></span><span class="side-channel-main"><b>${escapeHtml(channel.displayName || channel.login)}</b><small>${isWatching(channel) ? `${channel.queueLength == null ? '队列未知' : `队列 ${channel.queueLength}`}` : '尚未识别'}</small></span><span class="side-live">${isWatching(channel) ? '识别中' : ''}</span></button>`).join('');
}
function renderWatchedChannels(channels) {
  if (!ui.channelList) return;
  if (!channels.length) {
    ui.channelList.innerHTML = '<div class="empty-mini">打开频道后会出现在这里</div>';
    return;
  }
  ui.channelList.innerHTML = channels.slice(0, 30).map(channel => {
    const watching = isWatching(channel);
    const estimate = channel.estimate || {};
    const eta = estimate.estimatedMinutes == null ? '等待未知' : `约 ${estimate.estimatedMinutes} 分钟`;
    const queue = channel.queueLength == null ? '队列未知' : `队列 ${channel.queueLength}`;
    return `<button class="channel-row ${channel.login === model.currentLogin ? 'selected' : ''}" data-select-login="${escapeHtml(channel.login)}"><span class="channel-row-dot ${watching ? 'online' : ''}"></span><span class="channel-row-main"><b>${escapeHtml(channel.displayName || channel.login)}</b><small>${watching ? '最近有画面识别' : '尚无近期画面'} · ${escapeHtml(queue)}</small></span><span class="channel-row-eta">${escapeHtml(eta)}</span></button>`;
  }).join('');
}
function renderCurrentChannel() {
  const channel = getCurrentChannel();
  if (ui.activeChannelLabel) ui.activeChannelLabel.textContent = channel ? (channel.displayName || channel.login) : (model.currentLogin || '尚未选择');
  const recentScan = channel?.lastFrameAt ? `最近识别 ${fmtTime(channel.lastFrameAt)}` : '等待 Twitch 窗口中的识别操作';
  if (ui.recognitionStatus) ui.recognitionStatus.innerHTML = `<span>⌂</span>${escapeHtml(recentScan)}；图片仅传入本机 OCR，不保存、不上传。`;
  if (ui.pageState) {
    const watching = channel && isWatching(channel);
    ui.pageState.className = `state-pill ${watching ? 'watching' : model.currentLogin ? 'opened' : 'idle'}`;
    ui.pageState.innerHTML = `<i></i>${watching ? '最近已识别' : model.currentLogin ? '已选择频道' : '等待打开'}`;
  }
}
function renderReports(reports) {
  if (!ui.reportList || !ui.resultCount) return;
  ui.resultCount.textContent = String(reports.length);
  if (!reports.length) {
    ui.reportList.innerHTML = '<div class="empty-state"><div class="empty-orbit">⌗</div><h3>还没有检查点记录</h3><p>打开 Twitch 直播并识别当前画面后，结果会显示在这里。</p></div>';
    return;
  }
  const ordered = [...reports].sort((a, b) => Date.parse(b.observedAt || 0) - Date.parse(a.observedAt || 0));
  ui.reportList.innerHTML = ordered.slice(0, 60).map(report => {
    const confirmed = report.status === 'available';
    return `<article class="report-card"><div class="report-status ${confirmed ? 'verified' : 'candidate'}"><i></i>${confirmed ? '连续画面确认' : '候选 · 请复核'}</div><div class="report-main"><b>${escapeHtml(reportLabel(report))}</b><small>${escapeHtml(report.displayName || report.login || 'Twitch 频道')} · ${escapeHtml(fmtTime(report.observedAt))}</small></div><div class="report-queue">${report.queueLength == null ? '队列未知' : `队列 ${escapeHtml(report.queueLength)}`}</div></article>`;
  }).join('');
}
function renderRecommendations(items) {
  if (!ui.recommendationList) return;
  const recommendations = Array.isArray(items) ? items : [];
  const channels = selectedChannelList().filter(channel => (channel.reports || []).length || channel.queueLength != null);
  const entries = recommendations.length ? recommendations.map(item => ({
    login: item.login || item.report?.login || '',
    displayName: item.displayName || item.report?.displayName || item.login || item.report?.login || '未知频道',
    label: item.report ? reportLabel(item.report) : '已观察频道',
    queueLength: item.queueLength,
    estimatedMinutes: item.estimatedMinutes,
    confidence: item.confidence
  })) : channels.map(channel => ({
    login: channel.login,
    displayName: channel.displayName || channel.login,
    label: channel.reports?.length ? reportLabel(channel.reports[0]) : '已添加频道',
    queueLength: channel.queueLength,
    estimatedMinutes: channel.estimate?.estimatedMinutes,
    confidence: channel.estimate?.confidence
  }));
  if (!entries.length) {
    ui.recommendationList.innerHTML = '<div class="empty-mini">尚无可用的本机观察数据；等待未知</div>';
    return;
  }
  ui.recommendationList.innerHTML = entries.slice(0, 10).map(item => `<article class="recommend-row"><div class="recommend-top"><b>${escapeHtml(item.displayName)}</b><span>${item.estimatedMinutes == null ? '等待未知' : `约 ${escapeHtml(item.estimatedMinutes)} 分钟`}</span></div><small>${escapeHtml(item.label)} · ${item.queueLength == null ? '队列未知' : `队列 ${escapeHtml(item.queueLength)}`}</small><small class="recommend-confidence">${escapeHtml(item.confidence || '仅本机观察，样本不足时不估时')}</small></article>`).join('');
}
async function loadState(silent = true) {
  try {
    model.state = await api('/api/state');
    renderState();
  } catch (error) {
    if (!silent) toast(error.message || '无法读取本机工作台状态。', 'error');
  }
}
async function openChannel(value) {
  const login = validLogin(value ?? ui.channelLogin?.value);
  if (!login) { toast('请输入有效的 Twitch 频道登录名（1–25 位字母、数字或下划线）。', 'error'); ui.channelLogin?.focus(); return; }
  const bridge = webviewBridge();
  if (!bridge) {
    model.currentLogin = login;
    renderCurrentChannel();
    toast('打开 Twitch 网页需要通过桌面启动器运行；也可以在下方选择本机截图进行 OCR。', 'error');
    return;
  }
  try {
    bridge.postMessage({ type: 'open-twitch', login });
  } catch {
    toast('无法请求桌面 Twitch 窗口，请检查启动器状态。', 'error');
    return;
  }
  model.currentLogin = login;
  if (ui.channelLogin) ui.channelLogin.value = login;
  renderCurrentChannel();
  try {
    await api('/api/watch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ login }) });
    await loadState(true);
    toast(`已请求在桌面 Twitch 窗口打开 ${login}。请手动登录并播放。`);
  } catch (error) {
    toast(`已请求打开 ${login}，但频道记录未保存：${error.message || '本机服务错误'}`, 'error');
  }
}
function decodeBase64Image(value) {
  if (typeof value !== 'string') throw new Error('截图数据格式无效。');
  const base64 = value.replace(/^data:image\/[\w.+-]+;base64,/i, '').replace(/\s+/g, '');
  if (!base64 || base64.length > 8_400_000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) throw new Error('截图为空或超过 6 MiB 本机识别大小限制。');
  let binary;
  try { binary = atob(base64); } catch { throw new Error('无法解码桌面窗口截图。'); }
  if (!binary.length || binary.length > MAX_IMAGE_BYTES) throw new Error('截图超过 6 MiB 本机识别限制。');
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
async function handleCapture(message) {
  const login = validLogin(message.login);
  if (!login) { toast('桌面 Twitch 窗口没有返回有效频道。', 'error'); return; }
  if (message.requestId && /^\d{1,20}$/.test(String(message.requestId))) {
    const received = BigInt(message.requestId);
    if (model.lastRequestId !== null && received <= BigInt(model.lastRequestId)) {
      toast('忽略过期或重复的截图回传。');
      return;
    }
    model.lastRequestId = String(received);
  }
  if (!message.imageBase64) { toast('桌面窗口没有返回有效截图，请检查 Twitch 窗口顶部状态。', 'error'); return; }
  model.currentLogin = login;
  if (ui.channelLogin) ui.channelLogin.value = login;
  renderCurrentChannel();
  if (!model.state?.settings?.watchedChannels?.includes(login)) {
    try { await api('/api/watch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ login }) }); } catch { /* scan response remains authoritative */ }
  }
  if (model.scanBusy) { toast('上一张截图仍在本机 OCR 中，忽略这张重叠截图。'); return; }
  model.scanBusy = true;
  try {
    const bytes = decodeBase64Image(message.imageBase64);
    const result = await api(`/api/screen-scan?login=${encodeURIComponent(login)}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: bytes });
    await loadState(true);
    if (result.duplicate) toast(result.message || '画面与上次相同；等待视频画面更新。');
    else if (result.recognized) toast(`本机 OCR 已识别 ${Array.isArray(result.reports) ? result.reports.length : 0} 条候选，请人工核对。`);
    else toast(result.message || '本次画面未识别到明确检查点，请确认视频正在播放且清晰。');
  } catch (error) {
    await loadState(true);
    toast(error.message || '本机截图识别失败。', 'error');
  } finally { model.scanBusy = false; }
}
function onWebviewMessage(event) {
  let message = event?.data;
  if (typeof message === 'string') {
    try { message = JSON.parse(message); } catch { return; }
  }
  if (!message || typeof message !== 'object') return;
  if (message.type === 'twitch-window-opened') {
    const login = validLogin(message.login);
    if (login) {
      model.currentLogin = login;
      if (ui.channelLogin) ui.channelLogin.value = login;
      renderCurrentChannel();
      toast(`Twitch 页面已打开：${login}。请在窗口中手动登录并播放。`);
    }
    return;
  }
  if (message.type === 'screen-capture' && typeof message.imageBase64 === 'string' && message.imageBase64.length > 0) void handleCapture(message);
}
async function recognizeManualImage() {
  const file = ui.imageFile?.files?.[0];
  if (!file) { toast('请选择一张 PNG、JPEG 或 WEBP 图片。', 'error'); return; }
  if (file.size > MAX_IMAGE_BYTES) { toast('图片不能超过 6 MiB。', 'error'); return; }
  if (ui.imageTest) ui.imageTest.disabled = true;
  try {
    const result = await api('/api/image-test', {
      method: 'POST',
      headers: { 'Content-Type': file.type || 'application/octet-stream' },
      body: await file.arrayBuffer()
    });
    if (ui.manualResult) {
      ui.manualResult.textContent = JSON.stringify(result, null, 2);
      ui.manualResult.classList.remove('hidden');
    }
    const count = Array.isArray(result.reports) ? result.reports.length : 0;
    toast(result.recognized ? `手动截图识别完成：${count} 条进度候选。` : '手动截图已处理，但未识别到明确进度。');
  } catch (error) {
    toast(error.message || '手动截图识别失败。', 'error');
  } finally {
    if (ui.imageTest) ui.imageTest.disabled = !ui.imageFile?.files?.length;
  }
}
function bindEvents() {
  ui.openTwitch?.addEventListener('click', () => void openChannel());
  ui.channelLogin?.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); void openChannel(); } });
  ui.refresh?.addEventListener('click', () => void loadState(false));
  ui.imageFile?.addEventListener('change', () => {
    if (ui.imageTest) ui.imageTest.disabled = !ui.imageFile.files?.length;
    if (ui.manualResult) ui.manualResult.classList.add('hidden');
  });
  ui.imageTest?.addEventListener('click', () => void recognizeManualImage());
  if (ui.sideChannels) ui.sideChannels.addEventListener('click', event => {
    const button = event.target.closest('[data-select-login]');
    if (button) void openChannel(button.dataset.selectLogin);
  });
  if (ui.channelList) ui.channelList.addEventListener('click', event => {
    const button = event.target.closest('[data-select-login]');
    if (button) void openChannel(button.dataset.selectLogin);
  });
  if (webviewBridge()) webviewBridge().addEventListener('message', onWebviewMessage);
}

bindEvents();
void loadState(false);
setInterval(() => void loadState(true), 15_000);
