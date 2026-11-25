'use strict';

const model = {
  state: null,
  currentLogin: '',
  toastTimer: null,
  lastRequestId: null,
  scanBusy: false,
  authBusy: false,
  queueBusy: false,
  preview: null,
  pendingWebSend: null,
  progressRead: null,
  autoRead: null,
  autoReadSaving: false,
  autoReadTimer: null,
  nextAutoReadAt: 0
};
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
const WEB_SEND_TIMEOUT_MS = 45_000;
const CHANNEL_READ_TIMEOUT_MS = 23_000;
const FRAME_READ_TIMEOUT_MS = 25_000;
const AUTO_READ_INTERVAL_MS = 2 * 60_000;
const AUTO_READ_BUSY_DELAY_MS = 15_000;
const $ = id => document.getElementById(id);
const ui = {
  monitorStatus: $('monitor-status'), channelTotal: $('channel-total'),
  sideChannels: $('side-channels'), metricWatching: $('metric-watching'), metricReports: $('metric-reports'), metricScan: $('metric-scan'),
  refresh: $('refresh'), channelLogin: $('channel-login'), openTwitch: $('open-twitch'), openBrowser: $('open-twitch-browser'), activeChannelLabel: $('active-channel-label'),
  pageState: $('page-state'), recognitionStatus: $('recognition-status'), reportList: $('report-list'), resultCount: $('result-count'), recommendationList: $('recommendation-list'),
  channelList: $('channel-list'), watchedCount: $('watched-count'), imageFile: $('image-file'), imageTest: $('image-test'),
  manualResult: $('manual-result'), toast: $('toast'),
  readProgress: $('read-progress'), cancelRead: $('cancel-progress-read'), readStatus: $('progress-read-status'), readImport: $('read-import'),
  readMeter: $('progress-read-meter'), readResults: $('progress-read-results'),
  autoReadControl: $('auto-progress-control'), autoRead: $('auto-progress-read'), autoReadStatus: $('auto-progress-status'),
  accountPanel: $('twitch-account-panel'), accountStatus: $('account-status'), connectControls: $('connect-controls'),
  connect: $('twitch-connect'), authorization: $('device-authorization'),
  deviceCode: $('device-code'), deviceLink: $('device-link'), checkAuth: $('check-auth'),
  monitorControls: $('monitor-controls'), monitorNow: $('monitor-now'), disconnect: $('twitch-disconnect'), monitorStatusText: $('auto-monitor-status'),
  queueForm: $('queue-form'), playerId: $('player-id'), progressChoice: $('progress-choice'), prepareQueue: $('prepare-queue'),
  queuePreview: $('queue-preview'), queueRecommendation: $('queue-recommendation'), queueCommand: $('queue-command'),
  openQueueChat: $('open-queue-chat'), queueChatHint: $('queue-chat-hint'),
  copyQueue: $('copy-queue'), queueChannel: $('queue-channel'), queueStatus: $('queue-status')
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
function reportActivity(report) {
  return report.activity || '未核实的活动名称';
}
function reportEncounter(report) {
  const encounter = report.encounterLabel || report.encounter || '未核实的节点名称';
  return report.difficulty ? `${encounter} · ${report.difficulty}` : encounter;
}
function reportLabel(report) {
  return `${reportActivity(report)} · ${reportEncounter(report)}`;
}
function queueLabel(item, fallback = '队列未知') {
  if (item.queueStatus === 'closed') return '队列已关闭';
  const count = item.queueLength == null ? '' : `队列 ${item.queueLength} 人`;
  if (item.queueStatus === 'open') return count ? `队列开放 · ${count}` : '队列开放 · 人数未知';
  return count || fallback;
}
function isWatching(channel) {
  if (channel?.state === 'online') return true;
  if (channel?.state === 'offline') return false;
  if (typeof channel?.watching === 'boolean') return channel.watching;
  if (channel?.lastFrameAt) return Date.now() - Date.parse(channel.lastFrameAt) < 3 * 60_000;
  return false;
}
function getChannels() { return Array.isArray(model.state?.streams) ? model.state.streams : []; }
function getReports() { return Array.isArray(model.state?.reports) ? model.state.reports : []; }
function getCurrentChannel() { return getChannels().find(channel => channel.login === model.currentLogin) || null; }
function selectedChannelList() {
  const observations = new Map(getChannels().map(channel => [channel.login, channel]));
  const map = new Map((model.state?.monitor?.channels || []).map(channel => [channel.login, { ...observations.get(channel.login), ...channel }]));
  for (const [login, channel] of observations) if (!map.has(login)) map.set(login, channel);
  return [...map.values()];
}

function renderState() {
  if (!model.state) return;
  const channels = selectedChannelList();
  const watching = channels.filter(isWatching);
  const reports = getReports();
  if (ui.metricWatching) ui.metricWatching.textContent = String(watching.length);
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
  renderAccount();
  renderQueue();
  renderProgressRead();
}
function renderSideChannels(channels) {
  if (!ui.sideChannels) return;
  if (!channels.length) {
    ui.sideChannels.innerHTML = '<div class="empty-mini">还没有频道</div>';
    return;
  }
  ui.sideChannels.innerHTML = channels.slice(0, 14).map(channel => `<button class="side-channel ${channel.login === model.currentLogin ? 'selected' : ''}" data-select-login="${escapeHtml(channel.login)}"><span class="channel-dot ${isWatching(channel) ? 'online' : ''}"></span><span class="side-channel-main"><b>${escapeHtml(channel.displayName || channel.login)}</b><small>${channel.state === 'offline' ? '离线' : escapeHtml(queueLabel(channel, isWatching(channel) ? '队列未知' : '等待观察'))}</small></span><span class="side-live">${channel.state === 'online' ? '在线' : isWatching(channel) ? '最近已识别' : ''}</span></button>`).join('');
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
    const queue = queueLabel(channel);
    const status = channel.error || (channel.state === 'offline' ? '离线' : channel.state === 'online' ? '在线' : watching ? '最近已识别' : '等待观察');
    return `<button class="channel-row ${channel.login === model.currentLogin ? 'selected' : ''}" data-select-login="${escapeHtml(channel.login)}"><span class="channel-row-dot ${watching ? 'online' : ''}"></span><span class="channel-row-main"><b>${escapeHtml(channel.displayName || channel.login)}</b><small>${escapeHtml(status)} · ${escapeHtml(queue)}</small></span><span class="channel-row-eta">${escapeHtml(eta)}</span></button>`;
  }).join('');
}
function renderCurrentChannel() {
  const channel = getCurrentChannel();
  if (ui.activeChannelLabel) ui.activeChannelLabel.textContent = channel ? (channel.displayName || channel.login) : (model.currentLogin || '尚未选择');
  const recentScan = channel?.lastFrameAt ? `最近识别 ${fmtTime(channel.lastFrameAt)}` : '等待识别';
  if (ui.recognitionStatus) ui.recognitionStatus.textContent = recentScan;
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
    const hint = webviewBridge() ? '读取频道进度或导入直播截图，识别结果会显示在这里。' : '导入直播截图后，识别结果会显示在这里。';
    ui.reportList.innerHTML = `<div class="empty-state"><div class="empty-orbit" aria-hidden="true"></div><h3>还没有检查点记录</h3><p>${hint}</p></div>`;
    return;
  }
  const ordered = [...reports].sort((a, b) => Date.parse(b.observedAt || 0) - Date.parse(a.observedAt || 0));
  ui.reportList.innerHTML = ordered.map(report => {
    const confirmed = report.status === 'available';
    const translationNote = report.officialName === false ? ' · 官方译名待核实' : '';
    const commandNote = confirmed && !report.canRequest && report.queueStatus !== 'closed' ? ' · 指令待核实' : '';
    return `<article class="report-card">
      <div class="report-status ${confirmed ? 'verified' : 'candidate'}"><i></i>${confirmed ? '连续画面确认' : '候选 · 请复核'}</div>
      <div class="report-main"><b>${escapeHtml(reportActivity(report))}</b><small>${escapeHtml(reportEncounter(report))}</small><small class="report-source">${escapeHtml(report.displayName || report.login || 'Twitch 频道')} · ${escapeHtml(fmtTime(report.observedAt))}${translationNote}${commandNote}</small></div>
      <div class="report-queue">${escapeHtml(queueLabel(report))}</div>
    </article>`;
  }).join('');
}
function post(path, data = {}) {
  return api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
}
function renderAccount() {
  if (!ui.accountStatus) return;
  const account = model.state?.twitch || {};
  const monitor = model.state?.monitor || {};
  const device = account.device;
  ui.accountPanel.classList.toggle('hidden', !account.configured);
  ui.accountStatus.textContent = account.connected ? `已连接 @${account.login}` : device ? '等待 Twitch 授权' : '未连接';
  ui.accountStatus.className = `state-pill ${account.connected ? 'watching' : device ? 'opened' : 'idle'}`;
  ui.connectControls.classList.toggle('hidden', Boolean(account.connected || device));
  ui.authorization.classList.toggle('hidden', !device);
  ui.monitorControls.classList.toggle('hidden', !account.connected);
  ui.connect.disabled = model.authBusy;
  ui.checkAuth.disabled = model.authBusy;
  ui.monitorNow.disabled = Boolean(monitor.running);
  if (device) {
    ui.deviceCode.textContent = device.userCode;
    ui.deviceLink.href = device.verificationUri;
  } else {
    ui.deviceCode.textContent = '';
    ui.deviceLink.removeAttribute('href');
  }
  const count = (monitor.channels || []).filter(channel => channel.state === 'online').length;
  ui.monitorStatusText.textContent = monitor.error || (account.connected
    ? monitor.running ? '正在读取在线频道并识别直播预览…' : `${count} 个频道在线 · 最近一轮 ${fmtTime(monitor.lastScanAt)} · 预览可能延迟约 5 分钟`
    : '授权后自动识别所选频道的公开直播预览。');
}
async function updateAccount(route, body, silent = false) {
  if (model.authBusy) return;
  model.authBusy = true;
  renderAccount();
  try {
    await post(route, body);
    await loadState(silent);
  } catch (error) {
    if (!silent) toast(error.message, 'error');
    else if (ui.monitorStatusText) ui.monitorStatusText.textContent = error.message;
    await loadState(true);
  } finally {
    model.authBusy = false;
    renderAccount();
  }
}
function renderQueue() {
  if (!ui.progressChoice) return;
  const previousId = ui.progressChoice.value;
  const choices = new Map();
  for (const report of getReports()) {
    if (!report.canRequest) continue;
    const key = report.progressKey;
    if (!choices.has(key) || report.id === previousId) choices.set(key, report);
  }
  const options = [...choices.values()].sort((a, b) => reportLabel(a).localeCompare(reportLabel(b), 'zh-CN'));
  const text = options.length ? '选择所需检查点' : '等待可申请进度';
  ui.progressChoice.innerHTML = `<option value="">${text}</option>` + options.map(report => `<option value="${escapeHtml(report.id)}">${escapeHtml(reportLabel(report))}</option>`).join('');
  if (options.some(report => report.id === previousId)) ui.progressChoice.value = previousId;
  ui.playerId.disabled = model.queueBusy;
  ui.progressChoice.disabled = model.queueBusy || !options.length;
  ui.prepareQueue.disabled = model.queueBusy || !options.length;
  ui.queuePreview.classList.toggle('hidden', !model.preview);
  const embedded = Boolean(webviewBridge());
  ui.prepareQueue.textContent = embedded ? '匹配并发送' : '匹配最佳频道';
  ui.openQueueChat.textContent = embedded ? '登录 Twitch' : '在浏览器打开聊天';
  ui.openQueueChat.disabled = model.queueBusy;
  ui.queueChatHint.textContent = embedded
    ? '首次使用请登录 Twitch。每次申请会自动匹配频道并发送一条指令。'
    : '匹配后复制指令，在 Twitch 频道聊天中发送。';
  ui.copyQueue.classList.toggle('hidden', embedded);
  ui.queueChannel.classList.toggle('hidden', embedded);
  if (!model.preview) return;
  const { login, command, estimatedMinutes } = model.preview;
  ui.queueRecommendation.textContent = `推荐频道 @${login} · ${queueLabel(model.preview)} · ${estimatedMinutes == null ? '等待时间未知' : `估计 ${estimatedMinutes} 分钟`}`;
  ui.queueCommand.value = command;
  ui.queueChannel.href = `https://www.twitch.tv/popout/${encodeURIComponent(login)}/chat`;
}
function clearQueuePreview() {
  model.preview = null;
  ui.queueStatus.textContent = '仅可申请已确认可用且指令已核实的检查点。';
  renderQueue();
}
async function submitQueue(event) {
  event.preventDefault();
  if (model.queueBusy) return;
  const playerId = ui.playerId.value.trim();
  const reportId = ui.progressChoice.value;
  const bridge = webviewBridge();
  const selectionIsCurrent = () => ui.playerId.value.trim() === playerId && ui.progressChoice.value === reportId;
  const changedSelection = '所选进度已变化，请重新选择检查点。';
  model.preview = null;
  model.queueBusy = true;
  ui.queueStatus.textContent = '正在匹配可申请的频道…';
  renderQueue();
  if (bridge) cancelProgressRead();
  try {
    const preview = await post('/api/queue/preview', { bungieId: playerId, reportId });
    if (!selectionIsCurrent()) throw new Error(changedSelection);
    const request = { ...preview, bungieId: playerId };
    model.preview = request;
    if (!bridge) {
      ui.queueStatus.textContent = '在浏览器中把复制的指令粘贴到频道聊天并发送。';
      return;
    }

    ui.queueStatus.textContent = `正在 @${request.login} 的 Twitch 聊天中提交…`;
    renderQueue();
    const requestId = window.crypto.randomUUID();
    const { login, command } = await post('/api/queue/web-send', request);
    if (!selectionIsCurrent()) throw new Error(changedSelection);
    if (!validLogin(login) || login !== request.login || command !== request.command) throw new Error('频道或指令已变化，请重新匹配检查点。');
    const timer = setTimeout(() => {
      finishWebQueue(requestId, false, '未收到网页发送结果。请查看聊天确认状态，再决定是否重新匹配并发送。');
    }, WEB_SEND_TIMEOUT_MS);
    model.pendingWebSend = { requestId, request, timer };
    bridge.postMessage({ type: 'send-twitch-web', login, command, requestId });
  } catch (error) {
    if (model.pendingWebSend) {
      clearTimeout(model.pendingWebSend.timer);
      model.pendingWebSend = null;
    }
    ui.queueStatus.textContent = error.message;
  } finally {
    model.queueBusy = model.pendingWebSend !== null;
    renderQueue();
  }
}
function finishWebQueue(requestId, submitted, message) {
  const pending = model.pendingWebSend;
  if (!pending || pending.requestId !== requestId) return;
  clearTimeout(pending.timer);
  model.pendingWebSend = null;
  model.queueBusy = false;
  if (model.preview === pending.request) {
    const status = typeof message === 'string' ? message.trim() : '';
    ui.queueStatus.textContent = status || (submitted
      ? `已在 @${pending.request.login} 的 Twitch 聊天页提交。请查看机器人回复确认是否入队。`
      : '无法确认网页是否提交。请先查看频道聊天，再决定是否重新匹配并发送。');
  }
  renderQueue();
}
function openQueueChat() {
  if (model.queueBusy) return;
  const login = validLogin(model.preview?.login) || validLogin(ui.channelLogin?.value) || 'd2checkpoints';
  const bridge = webviewBridge();
  cancelProgressRead();
  try {
    if (bridge) {
      bridge.postMessage({ type: 'open-twitch-chat', login });
      toast(`已请求打开 @${login} 的 Twitch 聊天。请在窗口中登录。`);
    } else {
      window.open(`https://www.twitch.tv/popout/${encodeURIComponent(login)}/chat`, '_blank', 'noopener,noreferrer');
    }
  } catch {
    toast('无法打开 Twitch 聊天窗口，请重试。', 'error');
  }
}
async function copyQueue() {
  if (!model.preview) return;
  try {
    const copied = navigator.clipboard.writeText(ui.queueCommand.value);
    window.open(ui.queueChannel.href, '_blank', 'noopener,noreferrer');
    await copied;
    toast('已复制申请指令，请粘贴到频道聊天并发送。');
  } catch {
    ui.queueCommand.select();
    toast('请按 Ctrl+C 复制指令。');
  }
}
function renderRecommendations(items) {
  if (!ui.recommendationList) return;
  const recommendations = Array.isArray(items) ? items : [];
  const channels = selectedChannelList().filter(channel => channel.queueStatus !== 'closed' &&
    ((channel.reports || []).length || channel.queueLength != null || channel.queueStatus === 'open'));
  const entries = recommendations.length ? recommendations.map(item => ({
    login: item.login || item.report?.login || '',
    displayName: item.displayName || item.report?.displayName || item.login || item.report?.login || '未知频道',
    label: item.report ? reportLabel(item.report) : '已观察频道',
    queueLength: item.queueLength,
    queueStatus: item.queueStatus,
    estimatedMinutes: item.estimatedMinutes,
    confidence: item.confidence
  })) : channels.map(channel => ({
    login: channel.login,
    displayName: channel.displayName || channel.login,
    label: channel.reports?.length ? reportLabel(channel.reports[0]) : '已添加频道',
    queueLength: channel.queueLength,
    queueStatus: channel.queueStatus,
    estimatedMinutes: channel.estimate?.estimatedMinutes,
    confidence: channel.estimate?.confidence
  }));
  if (!entries.length) {
    ui.recommendationList.innerHTML = '<div class="empty-mini">尚无可用的本机观察数据</div>';
    return;
  }
  ui.recommendationList.innerHTML = entries.slice(0, 10).map(item => `<article class="recommend-row"><div class="recommend-top"><b>${escapeHtml(item.displayName)}</b><span>${item.estimatedMinutes == null ? '等待未知' : `约 ${escapeHtml(item.estimatedMinutes)} 分钟`}</span></div><small>${escapeHtml(item.label)} · ${escapeHtml(queueLabel(item))}</small><small class="recommend-confidence">${escapeHtml(item.confidence || '仅本机观察，样本不足时不估时')}</small></article>`).join('');
}
async function loadState(silent = true) {
  try {
    model.state = await api('/api/state');
    if (model.autoRead === null) model.autoRead = model.state.settings?.autoProgressRead === true;
    scheduleAutoProgressRead();
    renderState();
  } catch (error) {
    if (!silent) toast(error.message || '无法读取本机工作台状态。', 'error');
  }
}
function monitoredChannelLogins() {
  const settings = model.state?.settings;
  const overview = model.state?.monitor?.channels || [];
  return [...new Set([...overview.map(channel => channel.login), ...(settings?.watchedChannels || [])].map(validLogin).filter(Boolean))];
}
function postProgressPollTimer(delayMs) {
  try { webviewBridge()?.postMessage({ type: 'schedule-progress-poll', delayMs }); }
  catch { /* The web timer remains available. */ }
}
function clearAutoProgressPoll() {
  if (model.autoReadTimer === null) return;
  clearTimeout(model.autoReadTimer);
  model.autoReadTimer = null;
  model.nextAutoReadAt = 0;
  postProgressPollTimer(0);
}
function scheduleAutoProgressRead(delayMs = 1) {
  if (!model.autoRead || !webviewBridge() || model.progressRead?.running || model.autoReadTimer !== null || !monitoredChannelLogins().length) return;
  model.nextAutoReadAt = Date.now() + delayMs;
  const timer = setTimeout(() => {
    if (model.autoReadTimer === timer) runDueProgressPoll();
  }, delayMs);
  model.autoReadTimer = timer;
  postProgressPollTimer(delayMs);
  renderProgressRead();
}
function runDueProgressPoll() {
  if (model.autoReadTimer === null) return;
  clearAutoProgressPoll();
  if (model.scanBusy || model.queueBusy || model.state?.monitor?.running) {
    scheduleAutoProgressRead(AUTO_READ_BUSY_DELAY_MS);
    return;
  }
  if (model.autoRead) void startProgressRead(true);
}
function checkDueProgressPoll() {
  if (Date.now() + 50 >= model.nextAutoReadAt) runDueProgressPoll();
}
async function updateAutoProgressRead() {
  const enabled = ui.autoRead.checked;
  model.autoReadSaving = true;
  renderProgressRead();
  try {
    const saved = await post('/api/progress-read/settings', { enabled });
    model.autoRead = saved.enabled;
    if (model.autoRead) scheduleAutoProgressRead();
    else {
      clearAutoProgressPoll();
      if (model.progressRead?.automatic) cancelProgressRead();
    }
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    model.autoReadSaving = false;
    renderProgressRead();
  }
}
function renderProgressRead() {
  const batch = model.progressRead;
  const running = Boolean(batch?.running);
  const available = Boolean(webviewBridge());
  const channelCount = monitoredChannelLogins().length;
  ui.readProgress.disabled = !available || !channelCount || running;
  ui.autoReadControl.classList.toggle('hidden', !available);
  ui.autoRead.checked = model.autoRead === true;
  ui.autoRead.disabled = !available || model.autoRead === null || model.autoReadSaving;
  ui.autoReadStatus.textContent = model.autoReadSaving ? '正在保存…' : model.nextAutoReadAt ?
    `下轮约 ${fmtTime(model.nextAutoReadAt)}` : model.autoRead && running && batch.automatic ? '正在后台读取' : '每轮结束约 2 分钟后再读';
  ui.cancelRead.classList.toggle('hidden', !running || batch.cancelled);
  ui.readMeter.classList.toggle('hidden', !batch);
  ui.readResults.classList.toggle('hidden', !batch);
  if (!batch) {
    ui.readStatus.textContent = !available ? '一键读取在 Windows 桌面版可用。也可导入直播截图。' :
      channelCount ? `将依次识别 ${channelCount} 个频道的直播画面。` : model.state ? '添加 Twitch 频道后即可读取。' : '正在加载频道列表…';
    return;
  }

  const progress = `${batch.completed}/${batch.items.length}`;
  const current = batch.current?.login;
  const stopped = batch.cancelled || batch.failed;
  ui.readMeter.max = batch.items.length;
  ui.readMeter.value = batch.completed;
  const mode = batch.automatic ? '自动读取' : '读取';
  if (stopped) ui.readStatus.textContent = `已停止${mode} · 处理 ${progress} 个频道。`;
  else if (running) ui.readStatus.textContent = `${mode} ${progress} · ${current ? `正在读取 @${current}` : '正在准备'}`;
  else ui.readStatus.textContent = `${mode}完成 · 处理 ${progress} 个频道。`;
  ui.readResults.innerHTML = batch.items.map(item => {
    const outcome = item.message || (item === batch.current ? '正在读取…' : stopped ? '未读取' : '等待');
    const state = item.error ? 'error' : item === batch.current ? 'active' : '';
    return `<li class="read-result ${state}"><b>@${escapeHtml(item.login)}</b><span>${escapeHtml(outcome)}</span></li>`;
  }).join('');
}
function cancelChannelRead(bridge, requestId) {
  try { bridge.postMessage({ type: 'cancel-twitch-channel-read', requestId }); }
  catch { /* The local request still ends when cancelled or timed out. */ }
}
function requestChannelFrames(batch, login) {
  const requestId = window.crypto.randomUUID();
  const bridge = webviewBridge();
  if (!bridge) return Promise.resolve({ frames: [], message: '桌面识别窗口不可用。' });
  return new Promise(resolve => {
    const finish = value => {
      if (batch.pending?.requestId !== requestId) return;
      clearTimeout(timer);
      batch.pending = null;
      resolve(value);
    };
    const timer = setTimeout(() => {
      finish({ frames: [], message: '等待 Twitch 直播画面超时。' });
      cancelChannelRead(bridge, requestId);
    }, CHANNEL_READ_TIMEOUT_MS);
    batch.pending = { requestId, login, finish };
    try { bridge.postMessage({ type: 'read-twitch-channel', login, requestId, background: batch.automatic }); }
    catch { finish({ frames: [], message: '无法请求桌面识别窗口。' }); }
  });
}
function observedProgressKey(report) {
  return JSON.stringify([report.activityId || report.activityCode, report.encounterCode, report.difficultyCode]);
}
async function recognizeChannelFrames(batch, login, frames, reading) {
  for (const image of frames.slice(0, 2)) {
    if (batch.cancelled) break;
    try {
      const bytes = decodeBase64Image(image);
      const deadline = AbortSignal.timeout(FRAME_READ_TIMEOUT_MS);
      const scan = await api(`/api/screen-scan?login=${encodeURIComponent(login)}&layout=video&source=live`, {
        method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: bytes,
        signal: AbortSignal.any([batch.controller.signal, deadline])
      });
      if (scan.duplicate) reading.repeated = true;
      else {
        reading.latestScan = scan;
        for (const report of scan.result?.reports || []) reading.seen.add(observedProgressKey(report));
      }
    } catch (error) {
      reading.error = error.name === 'TimeoutError' ? '本机识别超时。' : (error.message || '本机识别失败。');
    }
  }
}
function summarizeProgressReading(reading) {
  const { latestScan, seen } = reading;
  const details = reading.error || (reading.repeated ? '有画面重复' : '');
  if (!latestScan) {
    const messages = [reading.note, details].filter(Boolean);
    return { message: messages.join(' · ') || '未收到可识别画面。', error: Boolean(reading.error || !reading.repeated) };
  }
  const confirmed = (latestScan.reports || []).filter(report => report.status === 'available' && seen.has(observedProgressKey(report))).length;
  const outcome = seen.size ? `读到 ${seen.size} 条进度，已确认 ${confirmed} 条` : '未识别到进度';
  const quality = seen.size < 2 && reading.frameHeight > 0 && reading.frameHeight < 720 ? `画面最高 ${reading.frameHeight}p` : '';
  return { message: [outcome, queueLabel(latestScan), quality, reading.note, details].filter(Boolean).join(' · '), error: false };
}
async function startProgressRead(automatic = false) {
  if (model.progressRead?.running || !webviewBridge()) return;
  if (model.scanBusy) { toast('正在识别截图，请稍后读取频道进度。'); return; }
  const logins = monitoredChannelLogins();
  if (!logins.length) return;
  clearAutoProgressPoll();
  const batch = { items: logins.map(login => ({ login })), automatic, running: true, cancelled: false, completed: 0,
    current: null, pending: null, controller: new AbortController() };
  model.progressRead = batch;
  renderProgressRead();
  try {
    for (const item of batch.items) {
      if (batch.cancelled) break;
      batch.current = item;
      renderProgressRead();
      const reading = { seen: new Set(), latestScan: null, repeated: false, error: '', note: '', frameHeight: 0 };
      let interrupted = false;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const response = await requestChannelFrames(batch, item.login);
        if (batch.cancelled) break;
        const frames = Array.isArray(response.frames) ? response.frames : [];
        for (const frame of Array.isArray(response.frameInfo) ? response.frameInfo.slice(0, 2) : []) {
          if (Number.isInteger(frame?.SourceHeight) && frame.SourceHeight > reading.frameHeight) reading.frameHeight = frame.SourceHeight;
        }
        interrupted = response.interrupted === true;
        const message = typeof response.message === 'string' ? response.message.trim() : '';
        reading.note = interrupted || frames.length < 2 ? message || (frames.length ? '只取到一张画面' : '没有获得直播画面。') : '';
        if (frames.length) await recognizeChannelFrames(batch, item.login, frames, reading);
        if (automatic || attempt > 0 || interrupted || batch.cancelled || !reading.latestScan || reading.seen.size >= 2 || reading.error) break;
        item.message = '正在同一频道重新取样…';
        renderProgressRead();
      }
      if (batch.cancelled) break;
      Object.assign(item, summarizeProgressReading(reading));
      if (!interrupted || reading.latestScan) batch.completed += 1;
      if (interrupted) batch.cancelled = true;
      batch.current = null;
      renderProgressRead();
      if (reading.latestScan) void loadState(true);
    }
  } catch (error) {
    batch.failed = true;
    if (batch.current) Object.assign(batch.current, { message: error.message || '无法读取频道。', error: true });
  } finally {
    batch.current = null;
    batch.running = false;
    scheduleAutoProgressRead(AUTO_READ_INTERVAL_MS);
    renderProgressRead();
    void loadState(true);
  }
}
function cancelProgressRead() {
  const batch = model.progressRead;
  if (!batch?.running || batch.cancelled) return;
  batch.cancelled = true;
  if (batch.current) batch.current.message = '已取消读取。';
  batch.controller.abort();
  if (batch.pending) {
    const { requestId, finish } = batch.pending;
    const bridge = webviewBridge();
    if (bridge) cancelChannelRead(bridge, requestId);
    finish({ frames: [] });
  }
  renderProgressRead();
}
async function openChannel(value, external = false) {
  const login = validLogin(value ?? ui.channelLogin?.value);
  if (!login) { toast('请输入有效的 Twitch 频道登录名（1–25 位字母、数字或下划线）。', 'error'); ui.channelLogin?.focus(); return; }
  const bridge = webviewBridge();
  cancelProgressRead();
  try {
    if (bridge && !external) bridge.postMessage({ type: 'open-twitch', login });
    else window.open(`https://www.twitch.tv/${encodeURIComponent(login)}`, '_blank', 'noopener,noreferrer');
  } catch {
    toast('无法请求桌面 Twitch 窗口，请检查启动器状态。', 'error');
    return;
  }
  model.currentLogin = login;
  if (ui.channelLogin) ui.channelLogin.value = login;
  renderCurrentChannel();
  toast(`已请求打开 ${login}。`);
  try {
    await api('/api/watch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ login }) });
    await loadState(true);
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
  if (model.scanBusy || model.progressRead?.running) { toast('已有画面正在读取，请稍后再识别当前画面。'); return; }
  model.scanBusy = true;
  try {
    const bytes = decodeBase64Image(message.imageBase64);
    const result = await api(`/api/screen-scan?login=${encodeURIComponent(login)}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: bytes });
    await loadState(true);
    if (result.duplicate) toast(result.message || '画面与上次相同；等待视频画面更新。');
    else if (result.result?.reports?.length) toast(`本机 OCR 已识别 ${result.result.reports.length} 条候选，请人工核对。`);
    else toast(queueLabel(result, result.message || '本次画面未识别到明确进度或队列，请确认视频正在播放且清晰。'));
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
  if (message.type === 'progress-poll-due') {
    checkDueProgressPoll();
    return;
  }
  if (message.type === 'twitch-channel-read') {
    const pending = model.progressRead?.pending;
    if (pending && message.requestId === pending.requestId && message.login === pending.login) pending.finish(message);
    return;
  }
  if (message.type === 'twitch-web-result') {
    finishWebQueue(message.requestId, message.submitted === true, message.message);
    return;
  }
  if (message.type === 'twitch-window-error') {
    const error = message.error ?? message.message;
    toast(typeof error === 'string' && error.trim() ? error : '无法打开 Twitch 频道窗口，请重试。', 'error');
    return;
  }
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
  const login = validLogin(ui.channelLogin?.value || model.currentLogin);
  if (!login) { toast('请先输入对应的 Twitch 频道登录名。', 'error'); ui.channelLogin?.focus(); return; }
  if (model.scanBusy) { toast('上一张截图仍在本机 OCR 中，请稍候。'); return; }
  cancelProgressRead();
  model.scanBusy = true;
  if (ui.imageTest) ui.imageTest.disabled = true;
  try {
    const scan = await api(`/api/screen-scan?login=${encodeURIComponent(login)}&layout=video`, {
      method: 'POST',
      headers: { 'Content-Type': file.type || 'application/octet-stream' },
      body: await file.arrayBuffer()
    });
    const result = scan.result || scan;
    await loadState(true);
    if (ui.manualResult) {
      const progress = (result.reports || []).map(reportLabel);
      ui.manualResult.textContent = [...progress, queueLabel(result, '')].filter(Boolean).join('\n') || '未识别到可显示的进度或队列。';
      ui.manualResult.classList.remove('hidden');
    }
    const count = Array.isArray(result.reports) ? result.reports.length : 0;
    toast(count ? `手动截图识别完成，读到 ${count} 条进度候选。` : queueLabel(result, '手动截图未识别到明确进度或队列。'));
  } catch (error) {
    toast(error.message || '手动截图识别失败。', 'error');
  } finally {
    model.scanBusy = false;
    if (ui.imageTest) ui.imageTest.disabled = !ui.imageFile?.files?.length;
  }
}
function bindEvents() {
  ui.openTwitch?.addEventListener('click', () => void openChannel());
  ui.openBrowser?.addEventListener('click', () => void openChannel(undefined, true));
  ui.channelLogin?.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); void openChannel(); } });
  ui.refresh?.addEventListener('click', () => void loadState(false));
  ui.readProgress?.addEventListener('click', () => void startProgressRead());
  ui.cancelRead?.addEventListener('click', cancelProgressRead);
  ui.autoRead?.addEventListener('change', () => void updateAutoProgressRead());
  ui.connect?.addEventListener('click', () => void updateAccount('/api/twitch/device'));
  ui.disconnect?.addEventListener('click', () => void updateAccount('/api/twitch/disconnect'));
  ui.checkAuth?.addEventListener('click', () => void updateAccount('/api/twitch/check'));
  ui.monitorNow?.addEventListener('click', async () => {
    try { await post('/api/monitor/refresh'); await loadState(false); }
    catch (error) { toast(error.message, 'error'); }
  });
  ui.queueForm?.addEventListener('submit', event => void submitQueue(event));
  ui.playerId?.addEventListener('input', clearQueuePreview);
  ui.progressChoice?.addEventListener('change', clearQueuePreview);
  ui.openQueueChat?.addEventListener('click', openQueueChat);
  ui.copyQueue?.addEventListener('click', () => void copyQueue());
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

function renderNavigation() {
  const section = window.location.hash || '#top';
  const links = document.querySelectorAll('.primary-nav .nav-link');
  const current = [...links].find(link => link.hash === section) || links[0];
  for (const link of links) {
    if (link === current) link.setAttribute('aria-current', 'location');
    else link.removeAttribute('aria-current');
  }
}

bindEvents();
window.addEventListener('hashchange', renderNavigation);
document.addEventListener('visibilitychange', checkDueProgressPoll);
renderNavigation();
if (!webviewBridge()) {
  ui.openTwitch.textContent = '用浏览器打开';
  ui.openBrowser.classList.add('hidden');
  ui.readImport.classList.remove('hidden');
}
renderQueue();
renderProgressRead();
void loadState(false);
setInterval(() => void loadState(true), 15_000);
setInterval(() => {
  if (model.state?.twitch?.device) void updateAccount('/api/twitch/check', undefined, true);
}, 5_000);
