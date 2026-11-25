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

function report(activityCode = 'VoG', encounterCode = 'Templar') {
  return {
    activity: activityCode === 'VoG' ? '玻璃宝库' : '王之陨落',
    activityCode,
    encounter: encounterCode === 'Templar' ? '圣堂武士' : '高尔戈洛斯',
    encounterCode,
    difficulty: '普通',
    difficultyCode: 'N'
  };
}

test('桌面画面扫描 HTTP 合约：安全握手、按频道双帧确认、拒绝旧 API', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'd2-screen-test-'));
  const launchKey = 'screen-scan-integration-key';
  const originalFetch = globalThis.fetch;
  const environment = Object.fromEntries(['D2_DATA_DIR', 'D2_HOST', 'D2_PORT', 'D2_LAUNCH_KEY'].map(key => [key, process.env[key]]));
  let externalFetchCalls = 0;
  let recognizeCalls = 0;
  const frames = new Map();
  const firstA = pngFrame(10);
  const secondA = pngFrame(11);
  const firstB = pngFrame(80);
  const secondB = pngFrame(81);
  const blankA = pngFrame(170);
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
  frames.set(crypto.createHash('sha256').update(blankA).digest('hex'), { recognized: false, queueLength: null, reports: [] });

  const visionPath = require.resolve('../desktop/vision');
  const mainPath = require.resolve('../desktop/main');
  const previousCache = { vision: require.cache[visionPath], main: require.cache[mainPath] };
  const visionStub = {
    async recognizeImage(image, options) {
      recognizeCalls += 1;
      assert.equal(options.isScreenshot, true);
      assert.ok(['channel_a', 'channel_b', 'channel_c', 'channel_webp_0', 'channel_webp_1', 'channel_webp_2'].includes(options.channel));
      const key = crypto.createHash('sha256').update(image).digest('hex');
      const result = frames.get(key);
      assert.ok(result, 'the HTTP body must be the exact submitted image bytes');
      return structuredClone(result);
    }
  };

  process.env.D2_DATA_DIR = dataDir;
  process.env.D2_HOST = '127.0.0.1';
  process.env.D2_PORT = '0';
  process.env.D2_LAUNCH_KEY = launchKey;
  globalThis.fetch = async () => { externalFetchCalls += 1; throw new Error('unexpected network access'); };
  require.cache[visionPath] = { id: visionPath, filename: visionPath, loaded: true, exports: visionStub };
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
    if (previousCache.main) require.cache[mainPath] = previousCache.main;
    if (previousCache.vision) require.cache[visionPath] = previousCache.vision;
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

    const stateBeforeScan = await httpRequest(port, '/api/state', 'GET', { Cookie: cookie });
    assert.equal(stateBeforeScan.status, 200);
    const initial = JSON.parse(stateBeforeScan.body);
    assert.equal(initial.capabilities.twitchDeveloperAppRequired, false);
    assert.equal(initial.capabilities.chatSending, false);

    const noOrigin = await imageRequest(port, 'channel_a', firstA, { cookie });
    assert.equal(noOrigin.status, 403, 'mutating screen scans require the exact local Origin');
    const wrongOrigin = await imageRequest(port, 'channel_a', firstA, { cookie, origin: `${origin}.evil` });
    assert.equal(wrongOrigin.status, 403);
    const unauthenticated = await imageRequest(port, 'channel_a', firstA, { origin });
    assert.equal(unauthenticated.status, 401, 'screen scans require the bootstrap session cookie');
    assert.equal(recognizeCalls, 0, 'rejected origins and sessions must not reach OCR');

    const malformed = await imageRequest(port, 'channel_a', Buffer.from('not an image'), { cookie, origin });
    assert.equal(malformed.status, 415, 'malformed image data must be rejected');
    const mismatchedType = await imageRequest(port, 'channel_a', firstA, { cookie, origin, contentType: 'text/html' });
    assert.equal(mismatchedType.status, 415, 'HTML bodies must not be accepted as screenshots');
    const mismatchedPngSignature = await imageRequest(port, 'channel_a', jpegC, { cookie, origin, contentType: 'image/png' });
    assert.equal(mismatchedPngSignature.status, 415, 'JPEG magic bytes must not be accepted under image/png');
    const mismatchedJpegSignature = await imageRequest(port, 'channel_a', firstA, { cookie, origin, contentType: 'image/jpeg' });
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
    const excessiveDimensionsResponse = await imageRequest(port, 'channel_a', excessiveDimensions, { cookie, origin });
    assert.equal(excessiveDimensionsResponse.status, 415, 'images above the 20 million pixel limit must be rejected');
    const brokenCrc = Buffer.from(firstA);
    brokenCrc[29] ^= 0x01;
    const brokenCrcResponse = await imageRequest(port, 'channel_a', brokenCrc, { cookie, origin });
    assert.equal(brokenCrcResponse.status, 415, 'PNG chunks with invalid CRC must be rejected');
    const oversizedResponse = await imageRequest(port, 'channel_a', Buffer.alloc(6 * 1024 * 1024 + 1), { cookie, origin });
    assert.equal(oversizedResponse.status, 413, 'uploads above the 6 MiB cap must be rejected');
    const invalidLogin = await imageRequest(port, 'not a channel!', firstA, { cookie, origin });
    assert.equal(invalidLogin.status, 400);
    assert.equal(recognizeCalls, 0, 'invalid data and channel names must not reach OCR');

    const firstCandidate = await imageRequest(port, 'channel_a', firstA, { cookie, origin });
    assert.equal(firstCandidate.status, 200);
    assert.equal(JSON.parse(firstCandidate.body).reports[0].status, 'candidate');
    assert.equal(recognizeCalls, 1);

    const repeat = await imageRequest(port, 'channel_a', firstA, { cookie, origin });
    assert.equal(repeat.status, 200);
    assert.equal(JSON.parse(repeat.body).duplicate, true);
    assert.equal(recognizeCalls, 1, 'identical image bytes must not trigger another OCR or confirmation');

    const firstOtherChannel = await imageRequest(port, 'channel_b', firstB, { cookie, origin });
    assert.equal(firstOtherChannel.status, 200);
    assert.equal(JSON.parse(firstOtherChannel.body).reports[0].status, 'candidate');

    const secondCandidate = await imageRequest(port, 'channel_a', secondA, { cookie, origin });
    assert.equal(secondCandidate.status, 200);
    assert.equal(JSON.parse(secondCandidate.body).reports[0].status, 'available');

    let stateResponse = await httpRequest(port, '/api/state', 'GET', { Cookie: cookie });
    let state = JSON.parse(stateResponse.body);
    let aReport = state.reports.find(item => item.login === 'channel_a');
    let bReport = state.reports.find(item => item.login === 'channel_b');
    assert.equal(aReport.status, 'available', 'same channel + distinct matching frame confirms a report');
    assert.equal(bReport.status, 'candidate', 'another channel cannot borrow the first channel frame');
    assert.ok(state.streams.some(item => item.login === 'channel_a'));
    assert.ok(state.streams.some(item => item.login === 'channel_b'));

    const secondOtherChannel = await imageRequest(port, 'channel_b', secondB, { cookie, origin });
    assert.equal(secondOtherChannel.status, 200);
    assert.equal(JSON.parse(secondOtherChannel.body).reports[0].status, 'available');

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

    const unreadable = await imageRequest(port, 'channel_a', blankA, { cookie, origin });
    assert.equal(unreadable.status, 200);
    assert.equal(JSON.parse(unreadable.body).recognized, false);
    assert.equal(JSON.parse(unreadable.body).reports[0].status, 'candidate');
    stateResponse = await httpRequest(port, '/api/state', 'GET', { Cookie: cookie });
    state = JSON.parse(stateResponse.body);
    assert.equal(state.reports.find(item => item.login === 'channel_a').status, 'candidate', 'an unrecognized new frame demotes that channel confirmation');
    assert.equal(state.reports.find(item => item.login === 'channel_b').status, 'available', 'an unrecognized frame on A must not demote B');

    for (const oldRoute of ['/api/auth/begin', '/api/auth/status', '/api/auth/logout', '/api/send-preview', '/api/send', '/api/refresh']) {
      const response = await httpRequest(port, oldRoute, 'POST', { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' }, Buffer.from('{}'));
      assert.equal(response.status, 405, `legacy route ${oldRoute} must no longer be implemented`);
    }
    assert.equal(externalFetchCalls, 0, 'screen scanning must never call Twitch or any external network endpoint');
  } finally {
    if (!cleanupRegistered) await cleanup();
  }
});
