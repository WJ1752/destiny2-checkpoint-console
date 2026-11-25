'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const test = require('node:test');

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, payload) {
  const name = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(payload.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([name, payload])));
  return Buffer.concat([length, name, payload, crc]);
}

// Produce an actual, decodable 64x64 RGB PNG; changing a pixel changes frame bytes.
function pngFrame(red, green = 40, blue = 90) {
  const width = 64;
  const height = 64;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // truecolour RGB
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x += 1) {
    row[1 + x * 3] = red;
    row[2 + x * 3] = green;
    row[3 + x * 3] = blue;
  }
  const pixels = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', zlib.deflateSync(pixels)),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

// Valid locally generated 64x64 baseline JPEG for MIME/signature acceptance coverage.
function validJpegFrame() {
  return Buffer.from('/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCABAAEADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDAooor1D4IKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooA/9k=', 'base64');
}

const WEBP_FIXTURES = {
  'VP8 ': 'UklGRkwAAABXRUJQVlA4IEAAAADQAwCdASpAAEAAPm02mEkkIyKhIggAgA2JaQB2AAAgbqagCvELcgAA/vD6K//+Ic6HOhy/9//i2kdCk8AAAAAA',
  'VP8L': 'UklGRiQAAABXRUJQVlA4TBcAAAAvP8APAAdQqHqUsf8BICH8f69F9D/1AwA=',
  'VP8X': 'UklGRnYAAABXRUJQVlA4WAoAAAAQAAAAPwAAPwAAQUxQSBAAAAABB1DaiAgACeH/ey2i/6kfVlA4IEAAAADQAwCdASpAAEAAPm02mEkkIyKhIggAgA2JaQB2AAAgbqagCvELcgAA/vD6K//+Ic6HOhy/9//i2kdCk8AAAAAA'
};
function webpFrame(kind) {
  if (!WEBP_FIXTURES[kind]) throw new Error(`Unknown WebP chunk: ${kind}`);
  return Buffer.from(WEBP_FIXTURES[kind], 'base64');
}

function httpRequest(port, requestPath, method = 'GET', headers = {}, body = Buffer.alloc(0)) {
  return new Promise((resolve, reject) => {
    const requestHeaders = { Host: `127.0.0.1:${port}`, ...headers };
    if (body.length && !requestHeaders['content-length']) requestHeaders['content-length'] = body.length;
    const request = http.request({ host: '127.0.0.1', port, method, path: requestPath, headers: requestHeaders }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString('utf8')
      }));
    });
    request.once('error', reject);
    if (body.length) request.write(body);
    request.end();
  });
}

function imageRequest(port, login, image, { cookie, origin, contentType = 'image/png' } = {}) {
  return httpRequest(port, `/api/screen-scan?login=${encodeURIComponent(login)}`, 'POST', {
    ...(cookie ? { Cookie: cookie } : {}),
    ...(origin ? { Origin: origin } : {}),
    'Content-Type': contentType
  }, image);
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    if (!server?.listening) return resolve();
    server.close(error => error ? reject(error) : resolve());
  });
}

function report() {
  return {
    activity: '国王的陨落',
    activityId: 'kingsFall',
    activityCode: 'KF',
    encounter: '战争祭司',
    encounterCode: 'Warpriest',
    officialName: true,
    difficulty: '普通',
    difficultyCode: 'N'
  };
}

test('桌面 HTTP 合约：会话握手、按频道双帧确认、申请预览与发送', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'd2-screen-test-'));
  const launchKey = 'screen-scan-integration-key';
  const originalFetch = globalThis.fetch;
  const environment = Object.fromEntries(['D2_DATA_DIR', 'D2_HOST', 'D2_PORT', 'D2_LAUNCH_KEY', 'D2_TWITCH_CLIENT_ID'].map(key => [key, process.env[key]]));
  const preferredChannel = 'd2checkpoints';
  const otherChannel = 'luckbot9';
  const autoReadChannel = 'travelerschosenteam';
  const postTemplarChannel = 'destiny2checkpoints';
  const sentMessages = [];
  let connected = false;
  let externalFetchCalls = 0;
  let recognizeCalls = 0;
  const frames = new Map();
  const firstA = pngFrame(10);
  const secondA = pngFrame(11);
  const firstB = pngFrame(80);
  const secondB = pngFrame(81);
  const closedA = pngFrame(164);
  const missingQueueA = pngFrame(165);
  const openedA = pngFrame(166);
  const blankA = pngFrame(170);
  const postTemplarFrames = [pngFrame(201), pngFrame(202)];
  const jpegC = validJpegFrame();
  const webpVp8 = webpFrame('VP8 ');
  const webpVp8l = webpFrame('VP8L');
  const webpVp8x = webpFrame('VP8X');
  frames.set(crypto.createHash('sha256').update(jpegC).digest('hex'), { recognized: true, queueLength: 4, reports: [report()] });
  for (const frame of [webpVp8, webpVp8l, webpVp8x]) frames.set(crypto.createHash('sha256').update(frame).digest('hex'), { recognized: true, queueLength: 5, reports: [report()] });
  frames.set(crypto.createHash('sha256').update(firstA).digest('hex'), { recognized: true, queueLength: 3, reports: [report()] });
  frames.set(crypto.createHash('sha256').update(secondA).digest('hex'), { recognized: true, queueLength: 3, reports: [report()] });
  frames.set(crypto.createHash('sha256').update(firstB).digest('hex'), { recognized: true, queueLength: 8, reports: [report()] });
  frames.set(crypto.createHash('sha256').update(secondB).digest('hex'), { recognized: true, queueLength: 7, reports: [report()] });
  frames.set(crypto.createHash('sha256').update(closedA).digest('hex'), { recognized: true, queueLength: null, queueStatus: 'closed', reports: [report()] });
  frames.set(crypto.createHash('sha256').update(missingQueueA).digest('hex'), { recognized: true, queueLength: null, queueStatus: null, reports: [report()] });
  frames.set(crypto.createHash('sha256').update(openedA).digest('hex'), { recognized: true, queueLength: 0, queueStatus: 'open', reports: [report()] });
  frames.set(crypto.createHash('sha256').update(blankA).digest('hex'), { recognized: false, queueLength: null, reports: [] });
  for (const frame of postTemplarFrames) {
    frames.set(crypto.createHash('sha256').update(frame).digest('hex'), { recognized: true, queueLength: 1, reports: [{
      activity: '玻璃拱顶', activityId: 'vaultGlass', activityCode: 'VoG', encounter: 'Post-Templar',
      encounterCode: 'PostTemplar', officialName: false, difficulty: '大师', difficultyCode: 'M'
    }] });
  }

  const visionPath = require.resolve('../desktop/vision');
  const twitchPath = require.resolve('../desktop/twitch');
  const mainPath = require.resolve('../desktop/main');
  const previousCache = { vision: require.cache[visionPath], twitch: require.cache[twitchPath], main: require.cache[mainPath] };
  const visionStub = {
    async recognizeImage(image, options) {
      recognizeCalls += 1;
      assert.equal(options.isScreenshot, options.channel !== autoReadChannel);
      assert.ok([preferredChannel, otherChannel, autoReadChannel, postTemplarChannel, 'channel_c', 'channel_webp_0', 'channel_webp_1', 'channel_webp_2'].includes(options.channel));
      const key = crypto.createHash('sha256').update(image).digest('hex');
      const result = frames.get(key);
      assert.ok(result, 'the HTTP body must be the exact submitted image bytes');
      return structuredClone(result);
    }
  };
  const twitchStub = {
    createTwitchClient({ clientId }) {
      assert.equal(clientId, undefined);
      return {
        status: () => ({ configured: connected, connected, login: connected ? 'local_test_user' : null }),
        async sendChat(login, command) {
          sentMessages.push({ login, command });
          return 'test-message-id';
        }
      };
    }
  };

  process.env.D2_DATA_DIR = dataDir;
  process.env.D2_HOST = '127.0.0.1';
  process.env.D2_PORT = '0';
  process.env.D2_LAUNCH_KEY = launchKey;
  delete process.env.D2_TWITCH_CLIENT_ID;
  globalThis.fetch = async () => { externalFetchCalls += 1; throw new Error('unexpected network access'); };
  require.cache[visionPath] = { id: visionPath, filename: visionPath, loaded: true, exports: visionStub };
  require.cache[twitchPath] = { id: twitchPath, filename: twitchPath, loaded: true, exports: twitchStub };
  delete require.cache[mainPath];

  let server;
  let desktop;
  let cleanupRegistered = false;
  const cleanup = async () => {
    await closeServer(server);
    if (desktop) await desktop.persist();
    globalThis.fetch = originalFetch;
    delete require.cache[mainPath];
    delete require.cache[visionPath];
    delete require.cache[twitchPath];
    if (previousCache.main) require.cache[mainPath] = previousCache.main;
    if (previousCache.vision) require.cache[visionPath] = previousCache.vision;
    if (previousCache.twitch) require.cache[twitchPath] = previousCache.twitch;
    for (const [key, value] of Object.entries(environment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  };

  try {
    desktop = require('../desktop/main');
    assert.equal(typeof desktop.makeServer, 'function');
    assert.equal(typeof desktop.scanScreen, 'function');
    assert.equal(typeof desktop.reportFreshness, 'function');
    assert.equal(typeof desktop.latestStateReports, 'function');

    const freshnessNow = Date.now();
    const halfFresh = desktop.reportFreshness({ observedAt: new Date(freshnessNow - 5 * 60_000).toISOString() }, freshnessNow);
    assert.deepEqual([halfFresh.fresh, halfFresh.freshnessPercent], [true, 50]);
    const expired = desktop.reportFreshness({ observedAt: new Date(freshnessNow - 11 * 60_000).toISOString() }, freshnessNow);
    assert.deepEqual([expired.fresh, expired.freshnessPercent], [false, 0]);
    const future = desktop.reportFreshness({ observedAt: new Date(freshnessNow + 5 * 60_000).toISOString() }, freshnessNow);
    assert.deepEqual([future.fresh, future.freshnessPercent], [true, 100], 'future clock skew must not exceed a full freshness bar');

    const manyReports = Array.from({ length: 120 }, (_, index) => ({
      id: String(index), login: `channel_${index % 4}`, observedAt: new Date(freshnessNow - index * 1000).toISOString()
    }));
    const visibleReports = desktop.latestStateReports(manyReports, 12);
    assert.equal(visibleReports.length, 12);
    assert.equal(new Set(visibleReports.map(item => item.login)).size, 4, 'the state window must not starve quieter channels');

    server = desktop.makeServer();
    await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', error => error ? reject(error) : resolve()));
    cleanupRegistered = true;
    t.after(cleanup);

    const { port } = server.address();
    const origin = `http://127.0.0.1:${port}`;
    const bootstrap = await httpRequest(port, '/', 'GET', { 'X-D2-Launch-Key': launchKey });
    assert.equal(bootstrap.status, 200);
    assert.match(bootstrap.headers['set-cookie'][0], /HttpOnly/);
    assert.match(bootstrap.headers['set-cookie'][0], /SameSite=Strict/);
    const cookie = bootstrap.headers['set-cookie'][0].split(';', 1)[0];
    const replay = await httpRequest(port, '/', 'GET', { 'X-D2-Launch-Key': launchKey });
    assert.equal(replay.status, 401, 'the one-use bootstrap key must not be replayable');

    const heroAsset = await httpRequest(port, '/ui/assets/orbital-watch.webp', 'GET', { Cookie: cookie });
    assert.equal(heroAsset.status, 200);
    assert.equal(heroAsset.headers['content-type'], 'image/webp');

    const stateBeforeScan = await httpRequest(port, '/api/state', 'GET', { Cookie: cookie });
    assert.equal(stateBeforeScan.status, 200);
    const initial = JSON.parse(stateBeforeScan.body);
    assert.equal(initial.capabilities.twitchDeveloperAppRequired, true);
    assert.equal(initial.capabilities.chatSending, false);
    assert.equal(initial.settings.autoProgressRead, false);

    const noOrigin = await imageRequest(port, preferredChannel, firstA, { cookie });
    assert.equal(noOrigin.status, 403, 'mutating screen scans require the exact local Origin');
    const wrongOrigin = await imageRequest(port, preferredChannel, firstA, { cookie, origin: `${origin}.evil` });
    assert.equal(wrongOrigin.status, 403);
    const unauthenticated = await imageRequest(port, preferredChannel, firstA, { origin });
    assert.equal(unauthenticated.status, 401, 'screen scans require the bootstrap session cookie');
    assert.equal(recognizeCalls, 0, 'rejected origins and sessions must not reach OCR');

    const malformed = await imageRequest(port, preferredChannel, Buffer.from('not an image'), { cookie, origin });
    assert.equal(malformed.status, 415, 'malformed image data must be rejected');
    const mismatchedType = await imageRequest(port, preferredChannel, firstA, { cookie, origin, contentType: 'text/html' });
    assert.equal(mismatchedType.status, 415, 'HTML bodies must not be accepted as screenshots');
    const mismatchedPngSignature = await imageRequest(port, preferredChannel, jpegC, { cookie, origin, contentType: 'image/png' });
    assert.equal(mismatchedPngSignature.status, 415, 'JPEG magic bytes must not be accepted under image/png');
    const mismatchedJpegSignature = await imageRequest(port, preferredChannel, firstA, { cookie, origin, contentType: 'image/jpeg' });
    assert.equal(mismatchedJpegSignature.status, 415, 'PNG magic bytes must not be accepted under image/jpeg');
    const oversizedHeader = Buffer.alloc(13);
    oversizedHeader.writeUInt32BE(5000, 0);
    oversizedHeader.writeUInt32BE(5000, 4);
    oversizedHeader[8] = 8;
    oversizedHeader[9] = 2;
    const excessiveDimensions = Buffer.concat([
      firstA.subarray(0, 8),
      pngChunk('IHDR', oversizedHeader),
      firstA.subarray(33)
    ]);
    const excessiveDimensionsResponse = await imageRequest(port, preferredChannel, excessiveDimensions, { cookie, origin });
    assert.equal(excessiveDimensionsResponse.status, 415, 'images above the 20 million pixel limit must be rejected');
    const brokenCrc = Buffer.from(firstA);
    brokenCrc[29] ^= 0x01;
    const brokenCrcResponse = await imageRequest(port, preferredChannel, brokenCrc, { cookie, origin });
    assert.equal(brokenCrcResponse.status, 415, 'PNG chunks with invalid CRC must be rejected');
    const oversizedResponse = await imageRequest(port, preferredChannel, Buffer.alloc(6 * 1024 * 1024 + 1), { cookie, origin });
    assert.equal(oversizedResponse.status, 413, 'uploads above the 6 MiB cap must be rejected');
    const invalidLogin = await imageRequest(port, 'not a channel!', firstA, { cookie, origin });
    assert.equal(invalidLogin.status, 400);
    assert.equal(recognizeCalls, 0, 'invalid data and channel names must not reach OCR');

    const firstCandidate = await imageRequest(port, preferredChannel, firstA, { cookie, origin });
    assert.equal(firstCandidate.status, 200);
    assert.equal(JSON.parse(firstCandidate.body).reports[0].status, 'candidate');
    assert.equal(recognizeCalls, 1);

    const repeat = await imageRequest(port, preferredChannel, firstA, { cookie, origin });
    assert.equal(repeat.status, 200);
    assert.equal(JSON.parse(repeat.body).duplicate, true);
    assert.equal(recognizeCalls, 1, 'identical image bytes must not trigger another OCR or confirmation');

    const firstOtherChannel = await imageRequest(port, otherChannel, firstB, { cookie, origin });
    assert.equal(firstOtherChannel.status, 200);
    assert.equal(JSON.parse(firstOtherChannel.body).reports[0].status, 'candidate');

    const secondCandidate = await imageRequest(port, preferredChannel, secondA, { cookie, origin });
    assert.equal(secondCandidate.status, 200);
    assert.equal(JSON.parse(secondCandidate.body).reports[0].status, 'available');

    let stateResponse = await httpRequest(port, '/api/state', 'GET', { Cookie: cookie });
    let state = JSON.parse(stateResponse.body);
    const aReport = state.reports.find(item => item.login === preferredChannel);
    const bReport = state.reports.find(item => item.login === otherChannel);
    assert.equal(aReport.status, 'available', 'same channel + distinct matching frame confirms a report');
    assert.equal(bReport.status, 'candidate', 'another channel cannot borrow the first channel frame');
    assert.ok(aReport.expiresAt, 'fresh reports expose their expiry timestamp');
    assert.ok(aReport.freshnessPercent > 0 && aReport.freshnessPercent <= 100, 'freshness percentage stays within 1–100');
    assert.equal(state.reportSummary.displayed, state.reports.length);
    assert.ok(state.reportSummary.total >= state.reportSummary.displayed);
    assert.ok(state.reportSummary.hidden >= 0);
    assert.ok(state.streams.some(item => item.login === preferredChannel));
    assert.ok(state.streams.some(item => item.login === otherChannel));

    const secondOtherChannel = await imageRequest(port, otherChannel, secondB, { cookie, origin });
    assert.equal(secondOtherChannel.status, 200);
    assert.equal(JSON.parse(secondOtherChannel.body).reports[0].status, 'available');

    const postJson = (requestPath, body, requestOrigin = origin) => httpRequest(port, requestPath, 'POST', {
      Cookie: cookie, Origin: requestOrigin, 'Content-Type': 'application/json'
    }, Buffer.from(JSON.stringify(body)));
    const autoProgressPath = '/api/progress-read/settings';
    assert.equal((await postJson(autoProgressPath, { enabled: 'true' })).status, 400);
    assert.deepEqual(JSON.parse((await postJson(autoProgressPath, { enabled: true })).body), { enabled: true });
    assert.equal(JSON.parse((await httpRequest(port, '/api/state', 'GET', { Cookie: cookie })).body).settings.autoProgressRead, true);
    assert.equal(JSON.parse(await fs.readFile(path.join(dataDir, 'state.json'), 'utf8')).settings.autoProgressRead, true);

    const bungieId = '测试玩家#0123';
    const previewResponse = await postJson('/api/queue/preview', { reportId: bReport.id, bungieId });
    assert.equal(previewResponse.status, 200);
    const preview = JSON.parse(previewResponse.body);
    assert.equal(preview.reportId, aReport.id);
    assert.equal(preview.login, preferredChannel, 'matching confirmed checkpoints should choose the shorter observed queue');
    assert.equal(preview.command, '!queue kf 2 n 测试玩家#0123');
    const request = { ...preview, bungieId };
    assert.equal((await postJson('/api/queue/send', request)).status, 401);
    connected = true;
    assert.equal((await postJson('/api/queue/send', { ...request, command: '!wrong 2 n 测试玩家#0123' })).status, 409);
    assert.equal((await postJson('/api/queue/send', { ...request, login: otherChannel })).status, 409);
    assert.equal((await postJson('/api/queue/send', request, `${origin}.evil`)).status, 403);
    assert.deepEqual(sentMessages, []);
    const sent = await postJson('/api/queue/send', request);
    assert.equal(sent.status, 200);
    assert.deepEqual(JSON.parse(sent.body), { login: preferredChannel, messageId: 'test-message-id' });
    assert.equal((await postJson('/api/queue/send', request)).status, 409);
    assert.deepEqual(sentMessages, [{ login: preferredChannel, command: preview.command }]);

    connected = false;
    const webPreview = await postJson('/api/queue/preview', { reportId: bReport.id, bungieId });
    assert.equal(webPreview.status, 200);
    const webRequest = { ...JSON.parse(webPreview.body), bungieId };
    assert.equal((await postJson('/api/queue/web-send', { ...webRequest, command: '!wrong' })).status, 409);
    assert.equal((await postJson('/api/queue/web-send', webRequest, `${origin}.evil`)).status, 403);
    const webSend = await postJson('/api/queue/web-send', webRequest);
    assert.equal(webSend.status, 200);
    assert.deepEqual(JSON.parse(webSend.body), { login: preferredChannel, command: preview.command });
    assert.equal((await postJson('/api/queue/web-send', webRequest)).status, 409);
    assert.equal((await postJson('/api/queue/send', webRequest)).status, 409);
    assert.equal(sentMessages.length, 1, 'the native webpage route should not call the Twitch API');

    const pendingPreview = await postJson('/api/queue/preview', { reportId: aReport.id, bungieId });
    assert.equal(pendingPreview.status, 200);
    for (const frame of [closedA, missingQueueA]) {
      const observed = await imageRequest(port, preferredChannel, frame, { cookie, origin });
      assert.equal(observed.status, 200);
      const queue = JSON.parse(observed.body);
      assert.equal(queue.queueStatus, 'closed');
      assert.equal(queue.queueLength, 3, 'an OCR miss must keep the latest fresh queue count');
    }
    const closedState = desktop.buildState();
    const closedReport = closedState.reports.find(item => item.id === aReport.id);
    assert.equal(closedReport.status, 'available');
    assert.equal(closedReport.canRequest, false);
    assert.equal(closedState.streams.find(item => item.login === preferredChannel).queueStatus, 'closed');
    assert.equal((await postJson('/api/queue/web-send', { ...JSON.parse(pendingPreview.body), bungieId })).status, 409);
    const alternative = await postJson('/api/queue/preview', { reportId: aReport.id, bungieId });
    assert.equal(JSON.parse(alternative.body).login, otherChannel, 'a closed queue must not win matching');

    assert.equal((await imageRequest(port, preferredChannel, openedA, { cookie, origin })).status, 200);
    const reopened = await postJson('/api/queue/preview', { reportId: aReport.id, bungieId });
    assert.equal(reopened.status, 200);
    assert.equal(JSON.parse(reopened.body).queueStatus, 'open');
    assert.equal(JSON.parse(reopened.body).queueLength, 0);

    for (const frame of postTemplarFrames) {
      assert.equal((await imageRequest(port, postTemplarChannel, frame, { cookie, origin })).status, 200);
    }
    const postTemplarState = JSON.parse((await httpRequest(port, '/api/state', 'GET', { Cookie: cookie })).body);
    const postTemplar = postTemplarState.reports.find(item => item.login === postTemplarChannel);
    assert.equal(postTemplar.officialName, false);
    assert.equal(postTemplar.canRequest, true);
    const postTemplarPreview = await postJson('/api/queue/preview', { reportId: postTemplar.id, bungieId });
    assert.equal(postTemplarPreview.status, 200);
    assert.equal(JSON.parse(postTemplarPreview.body).command, '!queue vog post-templar m 测试玩家#0123');

    const autoReadPath = `/api/screen-scan?login=${autoReadChannel}&layout=video&source=live`;
    for (const [index, frame] of [firstA, secondA].entries()) {
      const captured = await httpRequest(port, autoReadPath, 'POST', { Cookie: cookie, Origin: origin, 'Content-Type': 'image/png' }, frame);
      assert.equal(captured.status, 200);
      const [progress] = JSON.parse(captured.body).reports;
      assert.equal(progress.source, 'Twitch 直播画面');
      assert.equal(progress.status, index === 0 ? 'candidate' : 'available');
    }

    const jpegCandidate = await imageRequest(port, 'channel_c', jpegC, { cookie, origin, contentType: 'image/jpeg' });
    assert.equal(jpegCandidate.status, 200, 'a valid JPEG must be accepted by screen-scan');
    assert.equal(JSON.parse(jpegCandidate.body).reports[0].status, 'candidate');

    for (const [index, frame] of [webpVp8, webpVp8l, webpVp8x].entries()) {
      const candidate = await imageRequest(port, `channel_webp_${index}`, frame, { cookie, origin, contentType: 'image/webp' });
      assert.equal(candidate.status, 200, `valid ${['VP8 ', 'VP8L', 'VP8X'][index]} WebP dimensions must be accepted`);
    }
    const malformedWebp = webpVp8.subarray(0, webpVp8.length - 2);
    const malformedWebpResponse = await imageRequest(port, 'channel_c', malformedWebp, { cookie, origin, contentType: 'image/webp' });
    assert.equal(malformedWebpResponse.status, 415, 'truncated RIFF chunk must be rejected');

    const unreadable = await imageRequest(port, preferredChannel, blankA, { cookie, origin });
    assert.equal(unreadable.status, 200);
    assert.equal(JSON.parse(unreadable.body).recognized, false);
    assert.equal(JSON.parse(unreadable.body).reports[0].status, 'candidate');
    stateResponse = await httpRequest(port, '/api/state', 'GET', { Cookie: cookie });
    state = JSON.parse(stateResponse.body);
    assert.equal(state.reports.find(item => item.login === preferredChannel).status, 'candidate', 'an unrecognized new frame demotes that channel confirmation');
    assert.equal(state.reports.find(item => item.login === otherChannel).status, 'available', 'an unrecognized frame on one channel must not demote another');

    for (const oldRoute of ['/api/auth/begin', '/api/auth/status', '/api/auth/logout', '/api/send-preview', '/api/send', '/api/refresh']) {
      const response = await httpRequest(port, oldRoute, 'POST', { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' }, Buffer.from('{}'));
      assert.equal(response.status, 405, `legacy route ${oldRoute} must no longer be implemented`);
    }
    assert.equal(externalFetchCalls, 0, 'the mocked run must never call Twitch or any external network endpoint');
  } finally {
    if (!cleanupRegistered) await cleanup();
  }
});
