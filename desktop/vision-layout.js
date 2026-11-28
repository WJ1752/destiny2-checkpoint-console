'use strict';

const { CHANNELS } = require('./checkpoint-sources.js');

const BOARD_RIGHT = 0.75;
const BOARD_BOTTOM = 0.62;
const ROW_TOLERANCE = 0.007;
const COLUMN_INSET = 0.008;
const BODY_COLUMN_INSET = 0.03;
const ENCOUNTER_PATTERNS = new WeakMap();

function headerText(value) {
  return value.normalize('NFKC').toLowerCase().replace(/[iı|]/g, 'l').replace(/0/g, 'o').replace(/[^a-z0-9]/g, '');
}

function normalizedText(value) {
  return String(value || '').toLocaleLowerCase('en-US').replace(/[^\p{L}\p{N}]/gu, '');
}

function hasCheckpointBoard(words) {
  if (!Array.isArray(words)) return false;
  const checkpoint = headerText('Checkpoint');
  const list = headerText('List');
  const labels = words.filter(word => typeof word.text === 'string' && word.x >= 0 && word.x < 0.5 && word.y >= 0 && word.y < 0.13);
  return labels.some(word => {
    const title = headerText(word.text);
    if (title === checkpoint + list) return true;
    return title === checkpoint && labels.some(next => next.x > word.x && Math.abs(next.y - word.y) <= 0.02 && headerText(next.text) === list);
  });
}

function visualRows(words) {
  const positioned = words.filter(word => typeof word.text === 'string' && Number.isFinite(word.x) && Number.isFinite(word.y) && word.x >= 0 && word.x < BOARD_RIGHT && word.y >= 0.075 && word.y < BOARD_BOTTOM)
    .map(word => ({ ...word, end: word.x + (word.width || 0), centerY: word.y + (word.height || 0) / 2, textKey: headerText(word.text) }))
    .filter(word => word.textKey)
    .sort((left, right) => left.centerY - right.centerY || left.x - right.x);
  const rows = [];
  for (const word of positioned) {
    const previous = rows.at(-1);
    if (previous && word.centerY - previous.y <= ROW_TOLERANCE && word.centerY - previous.top <= ROW_TOLERANCE * 1.8) {
      previous.words.push(word);
      previous.y += (word.centerY - previous.y) / previous.words.length;
    } else rows.push({ y: word.centerY, top: word.centerY, words: [word] });
  }
  for (const row of rows) row.words.sort((left, right) => left.x - right.x);
  return rows;
}

function activityHeaders(activities, hasBoard, channel) {
  const aliases = new Map();
  for (const [activityId, activity] of Object.entries(activities)) {
    if (!activity.encounters?.length) continue;
    const encounterAliases = new Set(activity.encounters.flatMap(encounter => encounter.aliases || []).map(headerText));
    for (const label of [activity.activityCode, ...(activity.aliases || [])]) {
      if (typeof label !== 'string') continue;
      const key = headerText(label);
      if (key.length > 1 && !encounterAliases.has(key) && !aliases.has(key)) aliases.set(key, { activityId, label });
    }
  }
  // On the public checkpoint boards, WinRT regularly reads the stylized GotD badge as GoTo.
  if (hasBoard && aliases.has('gotd')) aliases.set('goto', aliases.get('gotd'));
  if (hasBoard && channel === 'd2chests' && Object.hasOwn(activities, 'equilibrium')) {
    aliases.set('e', { activityId: 'equilibrium', label: 'E' });
  }
  return aliases;
}

// Compare long titles conservatively. Short activity codes must match exactly.
function titleDistance(left, right) {
  if (left === right) return 0;
  const maximum = right.length >= 16 ? 2 : 1;
  if (right.length < 8 || left[0] !== right[0] || Math.abs(left.length - right.length) > maximum) return Infinity;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= right.length; column += 1) {
      current[column] = Math.min(current[column - 1] + 1, previous[column] + 1, previous[column - 1] + Number(left[row - 1] !== right[column - 1]));
    }
    if (Math.min(...current) > maximum) return Infinity;
    previous = current;
  }
  return previous.at(-1) <= maximum ? previous.at(-1) : Infinity;
}

function rowHeaders(row, aliases) {
  const candidates = [];
  for (let start = 0; start < row.words.length; start += 1) {
    let key = '';
    let match = null;
    for (let end = start; end < Math.min(row.words.length, start + 7); end += 1) {
      const word = row.words[end];
      if (end > start && word.x - row.words[end - 1].end > 0.025) break;
      key += word.textKey;
      if (key.length > 28) break;
      const exact = aliases.get(key);
      if (exact) {
        match = { ...exact, start, end, distance: 0, key };
        continue;
      }
      if (match?.distance === 0 || key.length < 7) continue;
      for (const [alias, candidate] of aliases) {
        const distance = titleDistance(key, alias);
        if (distance < (match?.distance ?? Infinity)) match = { ...candidate, start, end, distance, key };
      }
    }
    if (match) {
      const first = row.words[start];
      const last = row.words[match.end];
      candidates.push({ ...match, x: first.x, endX: last.end, text: row.words.slice(start, match.end + 1).map(word => word.text).join(' ') });
      start = match.end;
    }
  }
  return candidates;
}

function encounterPatterns(encounters) {
  const existing = ENCOUNTER_PATTERNS.get(encounters);
  if (existing) return existing;
  const patterns = encounters.flatMap(entry => (entry.aliases || []).flatMap(alias => {
    const key = normalizedText(alias.normalize('NFKC'));
    if (!key || /^\d+$/.test(key)) return [];
    const characters = Array.from(key).join('[\\s\\p{P}]*');
    const pattern = new RegExp(`(?<![\\p{L}\\p{N}])(?:\\d{1,2}\\s*[-:.]?\\s*)?${characters}(?![\\p{L}\\p{N}])`, 'giu');
    return [{ entry, pattern, length: key.length }];
  }));
  ENCOUNTER_PATTERNS.set(encounters, patterns);
  return patterns;
}

function isMasterSuffix(text) {
  return /^[\s\p{P}]*(?:master|m|大师)(?![\p{L}\p{N}])/iu.test(text);
}

function readEncounterLine(line, encounters) {
  if (!encounters.length) return [];
  const text = line.text.normalize('NFKC');
  const occurrences = [];
  for (const { entry, pattern, length } of encounterPatterns(encounters)) {
    for (const match of text.matchAll(pattern)) {
      occurrences.push({ entry, length, start: match.index, end: match.index + match[0].length });
    }
  }
  // Prefer complete aliases at the same position, while retaining other labels on the row.
  occurrences.sort((left, right) => right.length - left.length || left.start - right.start);
  const selected = [];
  for (const match of occurrences) {
    if (selected.every(other => match.end <= other.start || match.start >= other.end)) selected.push(match);
  }
  selected.sort((left, right) => left.start - right.start);
  if (selected.length) return selected.map(({ entry, end }, i) => ({
    entry, master: isMasterSuffix(text.slice(end, selected[i + 1]?.start))
  }));

  const slot = /^\s*(?:encounter\s+)?(\d{1,2})([\s\p{P}]*(?:master|normal|[mn]|大师|普通)?[\s\p{P}]*)$/iu.exec(text);
  const entry = slot && encounters.find(item => item.aliases?.includes(slot[1]));
  return entry ? [{ entry, master: isMasterSuffix(slot[2]) }] : [];
}

function sectionBottom(row, nextRow, hasBoard) {
  const bottom = nextRow ? nextRow.y - 0.012 : BOARD_BOTTOM;
  return hasBoard && nextRow ? bottom : Math.min(bottom, row.y + 0.175);
}

function columnBounds(header, nextX = BOARD_RIGHT) {
  const left = Math.max(0, header.x - COLUMN_INSET);
  const naturalWidth = header.key.length > 4 ? 0.24 : 0.165;
  const right = Math.min(nextX - COLUMN_INSET, Math.max(header.endX + COLUMN_INSET, header.x + naturalWidth));
  return { left, right };
}

function hasEncounterBelow(rows, heading, bottom, encounters) {
  const { left, right } = columnBounds(heading.headers[0]);
  return rows.some(row => {
    if (row.y < heading.y + 0.014 || row.y >= bottom) return false;
    const text = row.words.filter(word => {
      const centerX = (word.x + word.end) / 2;
      return centerX >= left && centerX <= right;
    }).map(word => word.text).join(' ');
    return readEncounterLine({ text }, encounters).length > 0;
  });
}

function uniqueEncounterSignatures(activities, activityAliases) {
  const signatures = new Map();
  for (const activity of Object.values(activities)) {
    if (typeof activity.activityCode !== 'string' || !activity.encounters?.length) continue;
    const key = headerText(activity.activityCode);
    const heading = activityAliases.get(key);
    if (!heading) continue;
    for (const encounter of activity.encounters) {
      for (const alias of encounter.aliases || []) {
        const token = headerText(alias);
        if (token.length < 4 || /^(?:boss|chest|encounter)/.test(token)) continue;
        const previous = signatures.get(token);
        signatures.set(token, previous === undefined || previous?.activityId === heading.activityId ? heading : null);
      }
    }
  }
  return signatures;
}

// A short title can disappear at stream quality. Recover its column only when
// two separate body lines align and both labels uniquely identify that activity.
function recoverColumns(rows, row, bottom, signatures) {
  const recovered = [];
  for (const body of rows) {
    if (body.y < row.y + 0.014 || body.y >= bottom) continue;
    for (let index = 0; index < body.words.length; index += 1) {
      const first = body.words[index];
      const previous = body.words[index - 1];
      if (previous && first.x - previous.end < 0.015) continue;
      if (row.headers.some(header => Math.abs(first.x - header.x) < BODY_COLUMN_INSET)) continue;
      let key = '';
      let heading;
      let endX = first.end;
      for (let next = index; next < Math.min(body.words.length, index + 4); next += 1) {
        const word = body.words[next];
        if (next > index && word.x - body.words[next - 1].end > 0.018) break;
        key += word.textKey;
        const match = signatures.get(key.replace(/^\d+/, ''));
        if (match) { heading = match; endX = word.end; }
      }
      if (!heading || row.headers.some(header => header.activityId === heading.activityId)) continue;

      const existing = recovered.find(candidate => candidate.activityId === heading.activityId && Math.abs(candidate.x - first.x) < 0.017);
      if (existing) existing.lines.add(body.y);
      else recovered.push({ ...heading, x: first.x, endX, key: headerText(heading.label), text: heading.label, lines: new Set([body.y]) });
    }
  }
  const supported = recovered.filter(candidate => candidate.lines.size >= 2);
  const separate = supported.filter(candidate => !supported.some(other => other !== candidate && Math.abs(other.x - candidate.x) < BODY_COLUMN_INSET));
  return [...row.headers, ...separate].sort((left, right) => left.x - right.x);
}

function layoutSections(words, ocrWidth, ocrHeight, activities, channel) {
  if (!CHANNELS.includes(channel) || ocrWidth <= 0 || ocrHeight <= 0 || !Array.isArray(words)) return [];
  const rows = visualRows(words);
  const hasBoard = hasCheckpointBoard(words);
  const aliases = activityHeaders(activities, hasBoard, channel);
  const detected = rows.map(row => ({ y: row.y, headers: rowHeaders(row, aliases) })).filter(row => row.headers.length > 0);
  const headings = [];
  for (let index = detected.length - 1; index >= 0; index -= 1) {
    const row = detected[index];
    const bottom = sectionBottom(row, headings.at(-1), hasBoard);
    if (row.headers.length > 1 || hasEncounterBelow(rows, row, bottom, activities[row.headers[0].activityId].encounters)) {
      headings.push({ ...row, bottom });
    }
  }
  const signatures = hasBoard ? uniqueEncounterSignatures(activities, aliases) : null;
  return headings.reverse().flatMap(row => {
    const top = Math.max(0, row.y - 0.015);
    const headers = signatures ? recoverColumns(rows, row, row.bottom, signatures) : row.headers;
    return headers.map((header, column) => {
      const { left, right } = columnBounds(header, headers[column + 1]?.x);
      return { activityId: header.activityId, headerAliases: [header.text, header.label], headerY: row.y, box: [left, top, right - left, row.bottom - top] };
    });
  });
}

module.exports = { hasCheckpointBoard, layoutSections, normalizedText, readEncounterLine };
