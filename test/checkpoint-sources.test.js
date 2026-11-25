'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { CHANNELS, buildQueueCommand, normalizeBungieId } = require('../desktop/checkpoint-sources.js');

test('uses a channel and encounter rule only when the published operands match', () => {
  assert.deepEqual(CHANNELS, ['d2checkpoints', 'soloraidsbot', 'luckbot9', 'destinycheckpoints', 'travelerschosenteam', 'd2chests', 'destiny2checkpoints']);
  const report = { login: 'd2checkpoints', activityId: 'kingsFall', activityCode: 'KF', encounterCode: 'Warpriest', difficultyCode: 'M' };
  assert.equal(buildQueueCommand(report, '测试 守护者#1234'), '!queue kf 2 m 测试 守护者#1234');
  assert.equal(buildQueueCommand({ ...report, login: 'soloraidsbot', queueCommand: '!queue arbitrary', slot: '2' }, 'Example#1234'), null);
  assert.equal(buildQueueCommand({ ...report, activityId: 'vaultGlass' }, 'Example#1234'), null);
  assert.equal(buildQueueCommand({ ...report, login: 'd2chests' }, 'Example#1234'), null);
  assert.equal(buildQueueCommand({ ...report, login: 'd2chests', encounterCode: 'Maze' }, 'Example#1234'), '!queue kf maze m Example#1234');
  assert.equal(buildQueueCommand({ ...report, encounterCode: 'constructor' }, 'Example#1234'), null);
});

test('accepts a Bungie name and four digits without admitting extra chat lines', () => {
  assert.equal(normalizeBungieId('  守护者#1234  '), '守护者#1234');
  for (const invalid of ['Example#123', 'Example#１２３４', 'Example#1234\n!queue Another#9999', '#1234', ' #1234', 'Example\u2028#1234', 'p'.repeat(27) + '#1234']) {
    assert.equal(normalizeBungieId(invalid), '', invalid);
  }
});
