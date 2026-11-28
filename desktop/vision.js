'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { layoutSections, normalizedText, readEncounterLine } = require('./vision-layout');
const { CHANNELS } = require('./checkpoint-sources');

const DATA_PATH = path.join(__dirname, 'vision-data.json');
const DATA = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
const UNKNOWN_QUEUE = Object.freeze({ queueLength: null, queueStatus: null });
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const OCR_TIMEOUT_MS = 20000;
const QUEUE_STATUS = /^(?:(?<closed>(?:closed|paused|disabled|not\s+open)\b|已?\s*(?:关闭|關閉|暂停|暫停))|(?:open|opened)\b|已?\s*(?:开放|開放))(?=\s*(?:$|[\p{P}\d]))/iu;

function result(recognized, queue, reports) {
  return { recognized, ...queue, reports };
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

function checkpointNames(activityId, encounterCode) {
  const activity = Object.hasOwn(DATA.activities, activityId) ? DATA.activities[activityId] : null;
  const code = normalizedText(encounterCode);
  const encounter = activity?.encounters.find((entry) => normalizedText(entry.encounterCode) === code);
  const activityName = activity?.nameSource ? activity.activity : null;
  const encounterName = encounter?.nameSource ? encounter.encounter : null;
  return {
    activityId,
    activity: activityName || '未核实的活动名称',
    encounter: encounterName || encounter?.aliases?.[0] || '未核实的进度节点',
    officialName: Boolean(activityName && encounterName)
  };
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

function queueLine(text) {
  const line = text.normalize('NFKC').trim();
  const waiting = /^(\d,\d{3}|\d{1,4})\s+(?:(?:players?|people)\s+)?(?:in\s+(?:the\s+)?queue|queued)\b/i.exec(line);
  if (waiting) return { queueLength: Number(waiting[1].replace(',', '')), queueStatus: null };

  const label = /^(?:(?:(?:checkpoint|current)\s+)?queue\b(?:\s+(?:size|length|status)\b)?|(?:[队隊]\s*列|排\s*[队隊])(?:\s*(?:人\s*[数數]|[状狀]\s*[态態]))?)/i.exec(line);
  if (!label) return UNKNOWN_QUEUE;
  const stripSeparators = value => value.replace(/^(?:is\s+|-\s+|[\s:=(\[\])–—])+/i, '');
  const value = stripSeparators(line.slice(label[0].length));
  const leadingState = QUEUE_STATUS.exec(value);
  const countValue = leadingState ? stripSeparators(value.slice(leadingState[0].length)) : value;
  const count = /^(\d,\d{3}|\d{1,4})(?=$|[\s)\]/人位])/.exec(countValue);
  const empty = /^(?:empty\b|无人(?:排队)?|無人(?:排隊)?|空(?:队列|隊列)?$)/i.test(countValue);
  const state = leadingState || (count && QUEUE_STATUS.exec(stripSeparators(countValue.slice(count[0].length))));
  const queueStatus = state ? (state.groups.closed ? 'closed' : 'open') : null;
  return { queueLength: count ? Number(count[1].replace(',', '')) : empty ? 0 : null, queueStatus };
}

function extractQueue(words, region, width, height) {
  const rect = getRect(region, width, height);
  let queueLength = null;
  let queueStatus = null;
  for (const line of wordLines(words, rect, width, height)) {
    const observed = queueLine(line.text);
    queueLength ??= observed.queueLength;
    if (queueStatus !== 'closed') queueStatus = observed.queueStatus ?? queueStatus;
  }
  return { queueLength, queueStatus };
}

function parseOcrResult(ocrResult, options = {}) {
  if (!ocrResult || !Number.isFinite(ocrResult.width) || !Number.isFinite(ocrResult.height) || ocrResult.width <= 0 || ocrResult.height <= 0 || !Array.isArray(ocrResult.words)) {
    return result(false, UNKNOWN_QUEUE, []);
  }
  const { profile } = resolveProfile(options.channel);
  const regionSet = options.isScreenshot === true ? DATA.imageRegions.screenshot : DATA.imageRegions.thumbnail;
  const listRect = getRect(regionSet.list, ocrResult.width, ocrResult.height);
  const wordsInList = ocrResult.words.filter((word) => typeof word.text === 'string' && isInside(word, listRect, ocrResult.width, ocrResult.height));
  const queue = extractQueue(ocrResult.words, regionSet.queue, ocrResult.width, ocrResult.height);
  const dynamicSections = options.isScreenshot === true ? [] :
    layoutSections(ocrResult.words, ocrResult.width, ocrResult.height, DATA.activities, canonicalChannel(options.channel));
  const dynamicCells = dynamicSections.map(section => {
    const [x, y, width, height] = section.box;
    return { section, cell: getRect({ x, y, width, height }, ocrResult.width, ocrResult.height) };
  });
  const listWidth = listRect.right - listRect.left;
  const listHeight = listRect.bottom - listRect.top;
  const fallbackCells = (profile.sections || []).map(section => {
    const [x, y, width, height] = section.box;
    const cell = {
      left: listRect.left + x * listWidth,
      top: listRect.top + y * listHeight,
      right: listRect.left + (x + width) * listWidth,
      bottom: listRect.top + (y + height) * listHeight
    };
    return { section, cell };
  });
  // Fixed cells can fill gaps, but their old boundaries can overlap moved columns.
  const fallbackWords = dynamicCells.length ? wordsInList.filter(word =>
    !dynamicCells.some(({ cell }) => isInside(word, cell, ocrResult.width, ocrResult.height))) : wordsInList;
  const sectionsSeen = new Set();
  const reports = [];
  const progressKeys = new Set();

  for (const { section, cell } of [...dynamicCells, ...fallbackCells]) {
    const dynamic = Number.isFinite(section.headerY);
    const lines = wordLines(dynamic ? wordsInList : fallbackWords, cell, ocrResult.width, ocrResult.height);
    const matchedHeader = dynamic ? null : lines.find(line => headerAlias(line, section.headerAliases) !== null);
    if (!dynamic && !matchedHeader) continue;
    sectionsSeen.add(section);

    const activityData = DATA.activities[section.activityId] || null;
    const knownActivity = activityData && section.activityId !== 'unknownRaid';
    const activityCode = knownActivity ? activityData.activityCode : headerAlias(matchedHeader, section.headerAliases);
    const encounterList = activityData?.encounters || [];
    const headerBottom = dynamic ? section.headerY * ocrResult.height + 4 :
      matchedHeader.centerY + Math.max(4, matchedHeader.height * 0.45);

    for (const line of lines) {
      if (line.centerY <= headerBottom) continue;
      for (const { entry, master } of readEncounterLine(line, encounterList)) {
        const report = {
          ...checkpointNames(section.activityId, entry.encounterCode),
          activityCode,
          encounterCode: entry.encounterCode,
          difficulty: master ? '大师' : '普通',
          difficultyCode: master ? 'M' : 'N'
        };
        const key = `${report.activityId}/${report.encounterCode}/${report.difficultyCode}`;
        if (progressKeys.has(key)) continue;
        progressKeys.add(key);
        reports.push(report);
      }
    }
  }

  const recognized = sectionsSeen.size >= (profile.minimumSections || 1) || queue.queueLength !== null || queue.queueStatus !== null;
  return result(recognized, queue, reports);
}

function resolveWorkerPath() {
  const regularPath = path.join(__dirname, 'vision-ocr.ps1');
  const unpackedPath = regularPath.replace(/([/\\])app\.asar([/\\])/i, '$1app.asar.unpacked$2');
  if (unpackedPath !== regularPath && fs.existsSync(unpackedPath)) return unpackedPath;
  return regularPath;
}

function runWindowsOcr(imageBuffer, preferEnglish) {
  if (process.platform !== 'win32') return Promise.reject(new Error('Windows OCR is only available on Windows.'));
  const workerPath = resolveWorkerPath();
  if (!fs.existsSync(workerPath)) return Promise.reject(new Error('Windows OCR is unavailable. Install or repair the application package.'));

  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', workerPath,
      ...(preferEnglish ? ['-PreferEnglish'] : [])
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
  const options = { channel, isScreenshot };
  const preferEnglish = !isScreenshot && CHANNELS.includes(canonicalChannel(channel));
  const ocr = await runWindowsOcr(imageBuffer, preferEnglish);
  const parsed = parseOcrResult(ocr, options);
  if (!Array.isArray(ocr.alternateWords)) return parsed;
  const fallback = parseOcrResult({ ...ocr, words: ocr.alternateWords }, options);
  // Keep difficulty from the preferred recognizer where both engines found the same checkpoint.
  const primaryCheckpoints = new Set(parsed.reports.map(report => `${report.activityId}/${report.encounterCode}`));
  const queue = { queueLength: parsed.queueLength ?? fallback.queueLength, queueStatus: parsed.queueStatus ?? fallback.queueStatus };
  return result(parsed.recognized || fallback.recognized, queue,
    [...parsed.reports, ...fallback.reports.filter(report => !primaryCheckpoints.has(`${report.activityId}/${report.encounterCode}`))]);
}

module.exports = {
  recognizeImage,
  checkpointNames,
  // Export the deterministic parser/profile helpers for tests and offline integrations.
  parseOcrResult,
  resolveProfile
};
