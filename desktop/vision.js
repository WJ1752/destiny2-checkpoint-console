'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const DATA_PATH = path.join(__dirname, 'vision-data.json');
const DATA = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
const EMPTY_RESULT = Object.freeze({ recognized: false, queueLength: null, reports: [] });
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const OCR_TIMEOUT_MS = 20000;

function result(recognized, queueLength, reports) {
  return { recognized, queueLength, reports };
}

function canonicalChannel(channel) {
  if (typeof channel !== 'string') return '';
  let value = channel.trim();
  if (/^https?:\/\//i.test(value)) {
    try { value = new URL(value).pathname.split('/').filter(Boolean)[0] || ''; } catch { return ''; }
  }
  return value.toLowerCase().replace(/^@/, '').replace(/[^a-z0-9]/g, '');
}

function resolveProfile(channel) {
  const id = canonicalChannel(channel);
  for (const [name, profile] of Object.entries(DATA.profiles)) {
    if (name === 'unknown') continue;
    if ((profile.channels || []).some((item) => canonicalChannel(item) === id)) return { name, profile };
  }
  return { name: 'unknown', profile: DATA.profiles.unknown };
}

function normalizedText(value) {
  return String(value || '').toLocaleLowerCase('en-US').replace(/[^\p{L}\p{N}]/gu, '');
}

function getRect(region, width, height) {
  return {
    left: region.x * width,
    top: region.y * height,
    right: (region.x + region.width) * width,
    bottom: (region.y + region.height) * height
  };
}

function wordCenter(word, width, height) {
  return {
    x: (word.x + (word.width || 0) / 2) * width,
    y: (word.y + (word.height || 0) / 2) * height
  };
}

function isInside(word, rect, width, height) {
  const center = wordCenter(word, width, height);
  return center.x >= rect.left && center.x <= rect.right && center.y >= rect.top && center.y <= rect.bottom;
}

// OCR returns word boxes, so group words by their visual baseline only after clipping
// them to one profile cell. This prevents a row of neighboring activity headings from
// being mistaken for one giant heading.
function wordLines(words, rect, width, height) {
  const cellHeight = rect.bottom - rect.top;
  const selected = words.filter((word) => typeof word.text === 'string' && word.text.trim() && isInside(word, rect, width, height))
    .map((word) => ({ ...word, center: wordCenter(word, width, height) }))
    .sort((a, b) => a.center.y - b.center.y || a.center.x - b.center.x);
  const groups = [];
  for (const word of selected) {
    let best = null;
    let bestDistance = Infinity;
    for (const group of groups) {
      const distance = Math.abs(group.centerY - word.center.y);
      const tolerance = Math.max(4, Math.min(cellHeight * 0.032, (group.height + word.height * height) * 0.55));
      if (distance <= tolerance && distance < bestDistance) {
        best = group;
        bestDistance = distance;
      }
    }
    if (!best) {
      groups.push({ words: [word], centerY: word.center.y, height: (word.height || 0) * height });
    } else {
      best.words.push(word);
      const top = Math.min(...best.words.map((item) => item.center.y - (item.height || 0) * height / 2));
      const bottom = Math.max(...best.words.map((item) => item.center.y + (item.height || 0) * height / 2));
      best.centerY = (top + bottom) / 2;
      best.height = bottom - top;
    }
  }
  return groups.map((group) => {
    const ordered = group.words.sort((a, b) => a.center.x - b.center.x);
    const left = Math.min(...ordered.map((item) => item.x * width));
    const right = Math.max(...ordered.map((item) => (item.x + (item.width || 0)) * width));
    const top = Math.min(...ordered.map((item) => item.y * height));
    const bottom = Math.max(...ordered.map((item) => (item.y + (item.height || 0)) * height));
    return {
      text: ordered.map((item) => item.text.trim()).join(' '),
      x: left / width,
      y: top / height,
      width: (right - left) / width,
      height: (bottom - top) / height,
      centerY: group.centerY
    };
  }).sort((a, b) => a.centerY - b.centerY);
}

function headerAlias(line, aliases) {
  const text = normalizedText(line.text);
  if (!text) return null;
  for (const alias of aliases || []) {
    const normalizedAlias = normalizedText(alias);
    if (!normalizedAlias) continue;
    // Short activity codes must be exact: e.g. E, ST and CE otherwise match encounter text.
    if (normalizedAlias.length <= 4 ? text === normalizedAlias : (text === normalizedAlias || text.includes(normalizedAlias))) return alias;
  }
  return null;
}

function encounterMatch(line, encounters) {
  const text = normalizedText(line.text);
  for (const entry of encounters || []) {
    for (const alias of entry.aliases || []) {
      const normalizedAlias = normalizedText(alias);
      if (!normalizedAlias) continue;
      if (/^\d+$/.test(alias.trim())) {
        const numberPattern = new RegExp(`(^|\\D)${alias.trim()}(\\D|$)`);
        if (numberPattern.test(line.text)) return entry;
      } else if (text.includes(normalizedAlias)) {
        return entry;
      }
    }
  }
  return null;
}

function isMaster(line) {
  return /\(\s*m\s*\)|\bmaster\b|(?:^|\s)m(?:\s|$)/i.test(line.text);
}

function extractQueue(words, region, width, height) {
  const rect = getRect(region, width, height);
  const text = wordLines(words, rect, width, height).map((line) => line.text).join(' ');
  const match = text.match(/\bqueue\s*[（(]?\s*(\d{1,4})\s*[）)]?/i);
  return match ? Number(match[1]) : null;
}

function parseOcrResult(ocrResult, options = {}) {
  if (!ocrResult || !Number.isFinite(ocrResult.width) || !Number.isFinite(ocrResult.height) || ocrResult.width <= 0 || ocrResult.height <= 0 || !Array.isArray(ocrResult.words)) {
    return result(false, null, []);
  }
  const { profile } = resolveProfile(options.channel);
  const regionSet = options.isScreenshot === true ? DATA.imageRegions.screenshot : DATA.imageRegions.thumbnail;
  const listRect = getRect(regionSet.list, ocrResult.width, ocrResult.height);
  const wordsInList = ocrResult.words.filter((word) => typeof word.text === 'string' && isInside(word, listRect, ocrResult.width, ocrResult.height));
  const queueLength = extractQueue(ocrResult.words, regionSet.queue, ocrResult.width, ocrResult.height);
  const sectionsSeen = new Set();
  const reports = [];

  for (const section of profile.sections || []) {
    const [x, y, sectionWidth, sectionHeight] = section.box;
    const cell = {
      left: listRect.left + x * (listRect.right - listRect.left),
      top: listRect.top + y * (listRect.bottom - listRect.top),
      right: listRect.left + (x + sectionWidth) * (listRect.right - listRect.left),
      bottom: listRect.top + (y + sectionHeight) * (listRect.bottom - listRect.top)
    };
    const lines = wordLines(wordsInList, cell, ocrResult.width, ocrResult.height);
    let headerIndex = -1;
    let matchedAlias = null;
    for (let index = 0; index < lines.length; index += 1) {
      const match = headerAlias(lines[index], section.headerAliases);
      if (match !== null) {
        headerIndex = index;
        matchedAlias = match;
        break;
      }
    }
    if (headerIndex < 0) continue;
    sectionsSeen.add(section);

    const activityData = DATA.activities[section.activityId] || null;
    const knownActivity = activityData && section.activityId !== 'unknownRaid';
    const activity = knownActivity ? activityData.activity : matchedAlias;
    const activityCode = knownActivity ? activityData.activityCode : matchedAlias;
    const encounterList = activityData?.encounters || [];
    const headerLine = lines[headerIndex];

    for (const line of lines) {
      if (line.centerY <= headerLine.centerY + Math.max(4, headerLine.height * 0.45)) continue;
      const matchedEncounter = encounterMatch(line, encounterList);
      if (!matchedEncounter) continue;
      const master = isMaster(line);
      const report = {
        activity,
        activityCode,
        encounter: matchedEncounter.encounter,
        encounterCode: matchedEncounter.encounterCode,
        difficulty: master ? '大师' : '普通',
        difficultyCode: master ? 'M' : 'N'
      };
      reports.push(report);
    }
  }

  const recognized = sectionsSeen.size >= (profile.minimumSections || 1) || queueLength !== null;
  return result(recognized, queueLength, reports);
}

function resolveWorkerPath() {
  const regularPath = path.join(__dirname, 'vision-ocr.ps1');
  const unpackedPath = regularPath.replace(/([/\\])app\.asar([/\\])/i, '$1app.asar.unpacked$2');
  if (unpackedPath !== regularPath && fs.existsSync(unpackedPath)) return unpackedPath;
  return regularPath;
}

function runWindowsOcr(imageBuffer) {
  if (process.platform !== 'win32') return Promise.reject(new Error('Windows OCR is only available on Windows.'));
  const workerPath = resolveWorkerPath();
  if (!fs.existsSync(workerPath)) return Promise.reject(new Error('Windows OCR is unavailable. Install or repair the application package.'));

  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', workerPath
    ], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let outputBytes = 0;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error('Windows OCR timed out.'));
    }, OCR_TIMEOUT_MS);
    child.stdout.on('data', (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_OUTPUT_BYTES) {
        child.kill();
        finish(new Error('Windows OCR output exceeded the safety limit.'));
        return;
      }
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 8192) stderr += chunk.toString('utf8').slice(0, 8192 - stderr.length);
    });
    child.on('error', (error) => finish(new Error(`Unable to start Windows OCR: ${error.message}`)));
    child.on('close', (code) => {
      if (settled) return;
      if (code !== 0) {
        finish(new Error('Windows OCR failed; no image content or system path is included in diagnostics.'));
        return;
      }
      try {
        const parsed = JSON.parse(stdout.trim());
        if (!Array.isArray(parsed.words)) throw new Error('Worker result has no words array.');
        finish(null, parsed);
      } catch (error) {
        finish(new Error(`Invalid Windows OCR result: ${error.message}`));
      }
    });
    child.stdin.on('error', (error) => {
      if (error.code !== 'EPIPE') finish(new Error(`Unable to supply image bytes to Windows OCR: ${error.message}`));
    });
    child.stdin.end(imageBuffer);
  });
}

async function recognizeImage(imageBuffer, { channel, isScreenshot = false } = {}) {
  if (!Buffer.isBuffer(imageBuffer)) throw new TypeError('recognizeImage expects a Buffer.');
  if (imageBuffer.length === 0 || imageBuffer.length > MAX_IMAGE_BYTES) throw new RangeError('Image must be between 1 byte and 6 MiB.');
  if (typeof isScreenshot !== 'boolean') throw new TypeError('isScreenshot must be a boolean.');
  const ocrResult = await runWindowsOcr(imageBuffer);
  return parseOcrResult(ocrResult, { channel, isScreenshot });
}

module.exports = {
  recognizeImage,
  // Export the deterministic parser/profile helpers for tests and offline integrations.
  parseOcrResult,
  resolveProfile
};
