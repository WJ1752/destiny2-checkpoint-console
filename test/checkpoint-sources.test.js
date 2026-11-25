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

test('formats verified application commands for all seven default channels', () => {
  const cases = [
    ['d2checkpoints', 'kingsFall', 'KF', 'Golgoroth', 'M', 'kf 3 m'],
    ['soloraidsbot', 'kingsFall', 'KF', 'Golgoroth', 'N', "King's Fall 3 Golgoroth N"],
    ['luckbot9', 'lastWish', 'LW', 'ShuroChi', 'N', 'lw shuro normal'],
    ['destinycheckpoints', 'rootNightmares', 'RoN', 'Nezarec', 'N', 'ron 4 n'],
    ['travelerschosenteam', 'salvationsEdge', 'SE', 'Verity', 'M', 'se 4 m'],
    ['d2chests', 'ghostsDeep', 'GotD', 'Boss', 'M', 'gotd boss m'],
    ['destiny2checkpoints', 'pInsurrection', 'P-Insurrection', 'InsurrectionPrime', 'N', 'p-insurrection insurrectionprime n'],
    ['destiny2checkpoints', 'salvationsEdge', 'SE', 'Verity', 'M', 'se verity m'],
    ['soloraidsbot', 'lastWish', 'LW', 'PostShuroChi', 'N', 'Last Wish 0 Post Shuro-Chi N'],
    ['soloraidsbot', 'desertPerpetual', 'DesertPerpetual', 'KoregosEAI', 'N', 'Desert Perpetual (Epic) 1 KoregosEAI N'],
    ['soloraidsbot', 'desertPerpetual', 'DesertPerpetual', 'KoregosAEI', 'N', 'Desert Perpetual (Epic) 2 KoregosAEI N'],
    ['d2chests', 'kingsFall', 'KF', 'Ships', 'M', 'kf ships m'],
    ['d2chests', 'crotasEnd', 'CE', 'Hallway', 'M', 'ce hallway m'],
    ['d2chests', 'equilibrium', 'Equilibrium', 'Chest2', 'N', 'e chest2 n']
  ];
  for (const [login, activityId, activityCode, encounterCode, difficultyCode, command] of cases) {
    const report = { login, activityId, activityCode, encounterCode, difficultyCode };
    assert.equal(buildQueueCommand(report, 'Guardian#1234'), `!queue ${command} Guardian#1234`, `${login}/${encounterCode}`);
    assert.equal(buildQueueCommand({ ...report, login: 'unlisted-channel' }, 'Guardian#1234'), null);
  }
});

test('accepts a Bungie name and four digits without admitting extra chat lines', () => {
  assert.equal(normalizeBungieId('  守护者#1234  '), '守护者#1234');
  for (const invalid of ['Example#123', 'Example#１２３４', 'Example#1234\n!queue Another#9999', '#1234', ' #1234', 'Example\u2028#1234', 'p'.repeat(27) + '#1234']) {
    assert.equal(normalizeBungieId(invalid), '', invalid);
  }
});
