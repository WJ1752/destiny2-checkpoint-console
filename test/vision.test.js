'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vision = require('../desktop/vision');

function word(text, x, y, width = 0.04, height = 0.018, imageWidth = 1920, imageHeight = 1080, listRegion = { x: 0.126, y: 0.14, width: 0.506, height: 0.38 }) {
  return {
    text,
    x: listRegion.x + x * listRegion.width,
    y: listRegion.y + y * listRegion.height,
    width: width * listRegion.width,
    height: height * listRegion.height,
    imageWidth,
    imageHeight
  };
}

function syntheticOcr(words, width = 1920, height = 1080) {
  return {
    width,
    height,
    words: words.map(({ imageWidth, imageHeight, ...item }) => item)
  };
}

test('D2Checkpoints layout maps abbreviated sections and Master encounters', () => {
  // These OCR word boxes mirror the two columns visible in the supplied public sample.
  const words = [
    word('VoG', 0.34, 0.50),
    word('3-Templar', 0.34, 0.58),
    word('5-Atheon (M)', 0.34, 0.63),
    { text: 'Queue', x: 0.67, y: 0.156, width: 0.03, height: 0.025 },
    { text: '(1)', x: 0.714, y: 0.156, width: 0.02, height: 0.025 }
  ];
  const output = vision.parseOcrResult(syntheticOcr(words), { channel: 'D2Checkpoints', isScreenshot: true });
  assert.equal(output.recognized, true);
  assert.equal(output.queueLength, 1);
  assert.deepEqual(output.reports, [
    { activityId: 'vaultGlass', officialName: true, activity: '玻璃拱顶', activityCode: 'VoG', encounter: '圣堂武士', encounterCode: 'Templar', difficulty: '普通', difficultyCode: 'N' },
    { activityId: 'vaultGlass', officialName: true, activity: '玻璃拱顶', activityCode: 'VoG', encounter: '埃希恩', encounterCode: 'Atheon', difficulty: '大师', difficultyCode: 'M' }
  ]);
});

test('SoloRaidsBot layout accepts full activity names and numbered encounters', () => {
  const words = [
    word("King's", 0.02, 0.15),
    word('Fall', 0.08, 0.15),
    word('3-Golgoroth', 0.02, 0.22),
    word('5-Oryx', 0.02, 0.28),
    word('(M)', 0.09, 0.28),
    word('Vault', 0.02, 0.49),
    word('of', 0.08, 0.49),
    word('Glass', 0.11, 0.49),
    word('3-Templar', 0.02, 0.56),
    word('Queue', 1.08, 0.07),
    word('(0)', 1.14, 0.07)
  ];
  const output = vision.parseOcrResult(syntheticOcr(words), { channel: 'soloraidsbot', isScreenshot: true });
  assert.equal(output.recognized, true);
  assert.equal(output.queueLength, 0);
  assert.deepEqual(output.reports, [
    { activityId: 'kingsFall', officialName: true, activity: '国王的陨落', activityCode: 'KF', encounter: '高尔格罗斯', encounterCode: 'Golgoroth', difficulty: '普通', difficultyCode: 'N' },
    { activityId: 'kingsFall', officialName: true, activity: '国王的陨落', activityCode: 'KF', encounter: '欧里克斯', encounterCode: 'Oryx', difficulty: '大师', difficultyCode: 'M' },
    { activityId: 'vaultGlass', officialName: true, activity: '玻璃拱顶', activityCode: 'VoG', encounter: '圣堂武士', encounterCode: 'Templar', difficulty: '普通', difficultyCode: 'N' }
  ]);
});

test('unknown channels use conservative full-name profile and do not guess unknown encounters', () => {
  const fullName = [
    word('Vault', 0.02, 0.49), word('of', 0.08, 0.49), word('Glass', 0.11, 0.49),
    word('3-Templar', 0.02, 0.56)
  ];
  const knownName = vision.parseOcrResult(syntheticOcr(fullName), { channel: 'unlisted-stream', isScreenshot: true });
  assert.equal(knownName.recognized, true);
  assert.equal(knownName.reports[0].activityCode, 'VoG');

  const abbreviated = vision.parseOcrResult(syntheticOcr([word('VoG', 0.02, 0.49), word('Templar', 0.02, 0.56)]), { channel: 'unlisted-stream', isScreenshot: true });
  assert.equal(abbreviated.recognized, false);
  assert.deepEqual(abbreviated.reports, []);

  const unknownEncounter = vision.parseOcrResult(syntheticOcr([
    word('King\'s', 0.02, 0.15), word('Fall', 0.08, 0.15), word('3-new-boss', 0.02, 0.22)
  ]), { channel: 'soloraidsbot', isScreenshot: true });
  assert.equal(unknownEncounter.recognized, true);
  assert.deepEqual(unknownEncounter.reports, []);
});

test('channel normalization resolves Twitch URL names and handles malformed OCR safely', () => {
  assert.equal(vision.resolveProfile('https://www.twitch.tv/D2Checkpoints').name, 'd2checkpoints');
  assert.equal(vision.resolveProfile('https://twitch.tv/soloraidsbot/').name, 'soloraidsbot');
  assert.equal(vision.parseOcrResult(null).recognized, false);
  assert.equal(vision.parseOcrResult({ width: 10, height: 10, words: [] }).recognized, false);
});

test('queue labels distinguish count, explicit state and chat instructions in a video crop', () => {
  const wordAt = (text, x = 0.77, y = 0.06) => ({ text, x, y, width: 0.04, height: 0.018 });
  const parse = (...words) => vision.parseOcrResult(syntheticOcr(words), { channel: 'd2checkpoints' });

  assert.deepEqual(parse(wordAt('Queue'), wordAt('OPEN：１２', 0.83)), {
    recognized: true, queueLength: 12, queueStatus: 'open', reports: []
  });
  assert.deepEqual(parse(wordAt('队列已关闭')), {
    recognized: true, queueLength: null, queueStatus: 'closed', reports: []
  });
  assert.deepEqual(parse(wordAt('0 players in queue')), {
    recognized: true, queueLength: 0, queueStatus: null, reports: []
  });
  assert.deepEqual(parse(wordAt('!queue 12'), wordAt('Queue', 0.77, 0.09), wordAt('8', 0.77, 0.12)), {
    recognized: false, queueLength: null, queueStatus: null, reports: []
  });
});

test('checkpoint labels prefer the complete encounter and preserve difficulty markers', () => {
  const output = vision.parseOcrResult(syntheticOcr([
    word('VoG', 0.34, 0.50), word('Post-Templar 〈M〉', 0.34, 0.58, 0.13)
  ]), { channel: 'd2checkpoints', isScreenshot: true });
  assert.equal(output.reports[0].encounterCode, 'PostTemplar');
  assert.equal(output.reports[0].difficultyCode, 'M');
});
