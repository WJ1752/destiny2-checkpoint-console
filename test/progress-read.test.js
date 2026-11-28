'use strict';

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { setImmediate: flushEvents } = require('node:timers/promises');
const vm = require('node:vm');

const appPath = path.join(__dirname, '../desktop/ui/app.js');
const appSource = readFileSync(appPath, 'utf8');
const login = 'd2checkpoints';

async function launchProgressUi() {
  const elements = new Map();
  const messages = [];
  const timers = new Map();
  let autoProgressRead = true;
  const document = new EventTarget();
  document.getElementById = id => {
    if (!elements.has(id)) {
      elements.set(id, Object.assign(new EventTarget(), {
        classList: { toggle() {} },
        removeAttribute() {},
        click() {
          if (!this.disabled) this.dispatchEvent(new Event('click'));
        }
      }));
    }
    return elements.get(id);
  };
  document.querySelectorAll = () => [];
  const webview = Object.assign(new EventTarget(), {
    postMessage(message) { messages.push({ ...message }); }
  });
  const window = Object.assign(new EventTarget(), { chrome: { webview }, crypto: { randomUUID }, location: {} });

  vm.runInNewContext(appSource, {
    window, document, AbortController,
    fetch: async (url, options) => {
      let data;
      if (url === '/api/state') {
        data = { settings: { autoProgressRead, watchedChannels: [login] } };
      } else {
        assert.equal(url, '/api/progress-read/settings');
        assert.equal(options.method, 'POST');
        autoProgressRead = JSON.parse(options.body).enabled;
        data = { enabled: autoProgressRead };
      }
      return { ok: true, text: async () => JSON.stringify(data) };
    },
    setTimeout(callback, delay) {
      const id = Symbol();
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    setInterval() {}
  }, { filename: appPath });
  await flushEvents();

  return {
    readButton: elements.get('read-progress'),
    cancelButton: elements.get('cancel-progress-read'),
    autoRead: elements.get('auto-progress-read'),
    posted: type => messages.filter(message => message.type === type),
    fireTimer(delay) {
      const entry = [...timers].find(([, timer]) => timer.delay === delay);
      assert.ok(entry, `Expected a ${delay} ms timer`);
      const [id, timer] = entry;
      timers.delete(id);
      timer.callback();
    },
    reply(request, interrupted) {
      const { requestId, login } = request;
      webview.dispatchEvent(new MessageEvent('message', {
        data: { type: 'twitch-channel-read', requestId, login, frames: [], interrupted }
      }));
    }
  };
}

test('进度读取取消后等待桌面回传，关闭自动轮询后仍以后台方式手动读取', async () => {
  const ui = await launchProgressUi();
  assert.equal(ui.autoRead.checked, true);
  ui.fireTimer(1);
  const reads = () => ui.posted('read-twitch-channel');
  assert.equal(reads().length, 1);
  const [oldRead] = reads();
  assert.equal(oldRead.login, login);
  assert.equal(oldRead.background, true);

  ui.cancelButton.click();
  assert.deepEqual(ui.posted('cancel-twitch-channel-read').map(message => message.requestId), [oldRead.requestId]);
  ui.autoRead.checked = false;
  ui.autoRead.dispatchEvent(new Event('change'));
  await flushEvents();
  assert.equal(ui.autoRead.checked, false);
  assert.equal(ui.readButton.disabled, true);
  ui.readButton.click();
  assert.equal(reads().length, 1);

  ui.reply(oldRead, true);
  await flushEvents();
  assert.equal(ui.readButton.disabled, false);
  assert.equal(reads().length, 1);
  ui.readButton.click();
  assert.equal(reads().length, 2);
  const manualRead = reads()[1];
  assert.equal(manualRead.login, login);
  assert.notEqual(manualRead.requestId, oldRead.requestId);
  assert.equal(manualRead.background, true);
});

test('桌面返回 interrupted 后保留下一轮自动轮询', async () => {
  const ui = await launchProgressUi();
  ui.fireTimer(1);
  const [request] = ui.posted('read-twitch-channel');
  ui.reply(request, true);
  await flushEvents();

  assert.equal(ui.autoRead.checked, true);
  assert.equal(ui.readButton.disabled, false);
  assert.deepEqual(ui.posted('schedule-progress-poll').map(message => message.delayMs), [1, 0, 120_000]);
  ui.fireTimer(120_000);
  const reads = ui.posted('read-twitch-channel');
  assert.equal(reads.length, 2);
  assert.notEqual(reads[1].requestId, request.requestId);
  assert.equal(reads[1].background, true);
});
