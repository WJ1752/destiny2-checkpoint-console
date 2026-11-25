'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { hasCheckpointBoard, layoutSections } = require('../desktop/vision-layout.js');
const { activities } = require('../desktop/vision-data.json');

function row(y, tokens) {
  return tokens.map(([x, text]) => ({ x, y, text, width: Math.min(text.length * 0.005, 0.08), height: 0.016 }));
}

// Minimal heading/coordinate excerpts from the seven public 1920×1080
// checkpoint overlays. Images, usernames and chat content are not retained.
const previews = {
  d2checkpoints: [[0.11, [[0.04, 'SE'], [0.29, 'Ro'], [0.31, 'N'], [0.42, 'VotD'], [0.55, 'CE']]], ['salvationsEdge', 'rootNightmares', 'vowDisciple', 'crotasEnd']],
  soloraidsbot: [[0.12, [[0.04, "King's"], [0.09, 'FalI'], [0.16, 'Root'], [0.20, 'OfNi'], [0.24, 'htm'], [0.27, 'ares'], [0.34, 'VOW'], [0.38, 'Of'], [0.39, 'the'], [0.42, 'DiscipIe']]], ['kingsFall', 'rootNightmares', 'vowDisciple']],
  luckbot9: [[0.12, [[0.04, 'KF'], [0.17, 'RO'], [0.19, 'N'], [0.30, 'SotW'], [0.40, 'GotD'], [0.52, 'DuaIity'], [0.61, 'WR']]], ['kingsFall', 'rootNightmares', 'spireWatcher', 'ghostsDeep', 'duality', 'warlordsRuin']],
  destinycheckpoints: [[0.11, [[0.04, 'KF'], [0.17, 'RoN'], [0.30, 'VotD'], [0.43, 'WR'], [0.55, 'SotW']]], ['kingsFall', 'rootNightmares', 'vowDisciple', 'warlordsRuin', 'spireWatcher']],
  travelerschosenteam: [[0.12, [[0.17, 'SotW'], [0.29, 'GotD'], [0.41, 'WR'], [0.52, 'Ro'], [0.54, 'N'], [0.65, 'G'], [0.67, 'oA']]], ['spireWatcher', 'ghostsDeep', 'warlordsRuin', 'rootNightmares', 'graspAvarice']],
  d2chests: [[0.12, [[0.04, 'KF'], [0.17, 'RON'], [0.30, 'VotD'], [0.43, 'GotD'], [0.55, 'G'], [0.57, 'oA']]], ['kingsFall', 'rootNightmares', 'vowDisciple', 'ghostsDeep', 'graspAvarice']],
  destiny2checkpoints: [[0.12, [[0.04, 'KF'], [0.17, 'RO'], [0.19, 'N'], [0.28, 'VotD'], [0.38, 'VoG'], [0.54, 'SE']]], ['kingsFall', 'rootNightmares', 'vowDisciple', 'vaultGlass', 'salvationsEdge']]
};

test('finds the varying top-row checkpoint columns on the supported Twitch overlays', () => {
  for (const [channel, [sample, expected]] of Object.entries(previews)) {
    const words = [
      ...row(...sample),
      ...row(0.69, [[0.03, '!queue'], [0.13, 'KF'], [0.18, 'RoN']])
    ];
    const sections = layoutSections(words, 1920, 1080, activities, channel);
    assert.deepEqual(sections.map(section => section.activityId), expected, channel);
    for (let index = 0; index < sections.length - 1; index += 1) {
      const [left, , width] = sections[index].box;
      assert.ok(left + width <= sections[index + 1].box[0] + Number.EPSILON, channel);
    }
  }
});

test('allows a final single activity row when supported by an encounter below it', () => {
  const words = [
    ...row(0.38, [[0.14, 'GoS'], [0.25, 'VoG'], [0.42, 'CE']]),
    ...row(0.49, [[0.04, 'DSC']]),
    ...row(0.52, [[0.04, 'Taniks']])
  ];
  const sections = layoutSections(words, 1920, 1080, activities, 'd2chests');
  assert.equal(sections.at(-1).activityId, 'deepStoneCrypt');
  assert.ok(sections[0].box[1] + sections[0].box[3] < sections.at(-1).headerY);
});

test('recovers missing abbreviated columns only when a public board has corroborating progress rows', () => {
  // The 1080p D2Checkpoints preview omits KF and RoN from the OCR heading.
  const title = row(0.05, [[0.052, 'Checkpoint'], [0.272, 'List']]);
  const board = [
    ...row(0.112, [[0.039, 'SE'], [0.419, 'VotD'], [0.553, 'CE']]),
    ...row(0.138, [[0.039, 'Chest1'], [0.172, 'Oryx'], [0.291, 'Chest1'], [0.420, 'Rhulk']]),
    ...row(0.161, [[0.039, 'Chest2'], [0.172, 'Warpriest'], [0.291, 'Nezarec'], [0.420, 'Caretaker']]),
    ...row(0.184, [[0.039, 'Witness'], [0.172, 'Wall'], [0.291, 'Scission'], [0.553, 'Abyss']]),
    ...row(0.2975, [[0.112, "A'"]]),
    ...row(0.3015, [[0.039, 'SotW'], [0.232, 'GoTo']]),
    ...row(0.3045, [[0.136, 'Duality']]),
    ...row(0.333, [[0.039, 'Boss'], [0.136, 'Boss'], [0.232, 'Boss'], [0.478, 'E']])
  ];
  const sections = layoutSections([...title, ...board], 1920, 1080, activities, 'd2checkpoints');
  assert.deepEqual(sections.map(section => section.activityId), [
    'salvationsEdge', 'kingsFall', 'rootNightmares', 'vowDisciple', 'crotasEnd', 'spireWatcher', 'duality', 'ghostsDeep'
  ]);
  assert.ok(sections[1].box[0] < 0.172 && sections[1].box[0] + sections[1].box[2] < 0.291);
  assert.equal(hasCheckpointBoard(board), false);
  assert.equal(hasCheckpointBoard([...title, ...board]), true);
  assert.equal(hasCheckpointBoard([...board, ...row(0.68, [[0.06, 'Checkpoint'], [0.27, 'List']])]), false);
  const unverified = layoutSections(board, 1920, 1080, activities, 'd2checkpoints');
  assert.ok(!unverified.some(section => ['kingsFall', 'rootNightmares', 'ghostsDeep', 'eaterWorlds'].includes(section.activityId)));
});
