'use strict';

const { activities: checkpointActivities } = require('./vision-data.json');

const CHANNELS = Object.freeze([
  'd2checkpoints', 'soloraidsbot', 'luckbot9', 'destinycheckpoints',
  'travelerschosenteam', 'd2chests', 'destiny2checkpoints'
]);

const creatorGuide = 'https://www.youtube.com/watch?v=og3tooPLjOU';
const teamGuide = 'https://www.youtube.com/watch?v=aQU3L8Iy4lQ';
const queueHelper = 'https://github.com/TravelersChosen/CheckpointQueueHelper/blob/main/queuehelper.html#L328';
const expandedQueueHelper = 'https://github.com/TravelersChosen/CheckpointQueueHelper/blob/main/index.html#L508';
const currentQueueHelper = 'https://www.travelerschosen.org/#/queuehelper';
const queueSheets = 'https://docs.google.com/spreadsheets/d/1JmV-28EMiC9q8hnSbtpTprtVjDcrPKPgE_UDuJQIQ8c/edit?gid=';
const vespersReplay = 'https://www.twitch.tv/videos/2931315720?t=18h49m22s';

const CHANNEL_SOURCES = Object.freeze({
  d2checkpoints: Object.freeze([creatorGuide, teamGuide, queueHelper, vespersReplay]),
  soloraidsbot: Object.freeze([`${queueSheets}353487289`, 'https://www.twitch.tv/soloraidsbot', 'https://www.youtube.com/watch?v=PgvKXmeQznA&t=227s']),
  luckbot9: Object.freeze([creatorGuide, teamGuide, queueHelper]),
  destinycheckpoints: Object.freeze([teamGuide, queueHelper]),
  travelerschosenteam: Object.freeze([creatorGuide, teamGuide, queueHelper]),
  d2chests: Object.freeze([currentQueueHelper, `${queueSheets}1882844670`, 'https://www.twitch.tv/d2chests']),
  destiny2checkpoints: Object.freeze([currentQueueHelper, `${queueSheets}1939180325`, 'https://www.twitch.tv/destiny2checkpoints'])
});

const ACTIVITIES = {
  kingsFall: { code: 'kf', master: true, encounters: { totems: '1', basilica: '1', warpriest: '2', golgoroth: '3', daughters: '4', oryx: '5', maze: 'maze', wall: 'wall' } },
  rootNightmares: { code: 'ron', master: true, encounters: { cataclysm: '1', scission: '2', macrocosm: '3', explicator: '3', nezarec: '4', chest1: 'chest1', chest2: 'chest2' } },
  vowDisciple: { code: 'votd', master: true, encounters: { acquisition: '1', caretaker: '2', exhibition: '3', rhulk: '4', chest1: 'chest1', chest2: 'chest2' } },
  salvationsEdge: { code: 'se', master: true, encounters: { substratum: '1', dissipation: '2', herald: '2', repository: '3', verity: '4', witness: '5', chest1: 'chest1', chest2: 'chest2' } },
  spireWatcher: { code: 'sotw', master: true, encounters: { ascent: '1', akacys: '2', akelous: '2', persys: '3', '1': '1', '2': '2', chest1: 'chest1', chest2: 'chest2' } },
  duality: { code: 'duality', master: true, encounters: { gahlran: '1', vault: '2', caiatl: '3', '1': '1', '2': '2', chest1: 'chest1', chest2: 'chest2' } },
  ghostsDeep: { code: 'gotd', master: true, encounters: { ritual: '1', ecthar: '2', simmumah: '3', chest1: 'chest1' } },
  crotasEnd: { code: 'ce', master: true, encounters: { abyss: '1', bridge: '2', deathsinger: '3', crota: '4', chest2: 'chest2' } },
  graspAvarice: { code: 'goa', master: true, encounters: { ogre: '1', shield: '2', avarokk: '3', '1': '1', '2': '2', chest1: 'chest1', chest2: 'chest2' } },
  vaultGlass: { code: 'vog', master: true, encounters: { confluxes: '1', oracles: '2', templar: '3', gatekeeper: '4', atheon: '5', posttemplar: 'post-templar' } },
  lastWish: { code: 'lw', encounters: { kalli: '1', shurochi: '2', morgeth: '3', vault: '4', riven: '5', chest2: 'chest2', '2': '2', '5': '5' } },
  deepStoneCrypt: { code: 'dsc', encounters: { cryptsecurity: '1', atraks: '2', descent: '3', taniks: '4', chest2: 'chest2' } },
  warlordsRuin: { code: 'wr', master: true, encounters: { rathil: '1', hefnd: '3', '2': '2', chest: 'chest' } },
  gardenSalvation: { code: 'gos', encounters: { embrace: '1', undergrowth: '2', consecratedmind: '3', sanctifiedmind: '4', chest1: 'chest1', chest2: 'chest2' } },
  vespersHost: { code: 'vh', master: true, encounters: { '1': '1', '2': '2', '3': '3', chest1: 'chest1', chest2: 'chest2' } },
  sunderedDoctrine: { code: 'sd', master: true, encounters: { '1': '1', '2': '2', '3': '3', chest1: 'chest1', chest2: 'chest2' } },
  equilibrium: { code: 'e', encounters: { chest2: 'chest2' } },
  pInsurrection: { code: 'p-insurrection', encounters: { insurrectionprime: 'insurrectionprime', calus: 'calus', morgeth: 'morgeth' } },
  pCalus: { code: 'p-calus', encounters: { calus: 'calus' } },
  pMorgeth: { code: 'p-morgeth', encounters: { morgeth: 'morgeth' } }
};

// SoloRaidsBot publishes full activity names and uses the numbered encounter label.
const SOLO_ACTIVITIES = {
  kingsFall: { name: "King's Fall", encounters: { maze: 'Maze', golgoroth: '3 Golgoroth', oryx: '5 Oryx' } },
  rootNightmares: { name: 'Root of Nightmares', encounters: { macrocosm: '3 Explicator', nezarec: '4 Nezarec' } },
  vowDisciple: { name: 'Vow of the Disciple', encounters: { acquisition: '1 Acquisition', caretaker: '2 Caretaker' } },
  salvationsEdge: { name: "Salvation's Edge", encounters: { herald: '2 Herald', repository: '3 Repository', witness: '5 Witness' } },
  vaultGlass: { name: 'Vault of Glass', encounters: { templar: '3 Templar', gatekeeper: '4 Gatekeeper', atheon: '5 Atheon' } },
  crotasEnd: { name: "Crota's End", encounters: { deathsinger: '3 Deathsinger', crota: '4 Crota' } },
  lastWish: { name: 'Last Wish', encounters: { postshurochi: '0 Post Shuro-Chi', shurochi: '2 Shuro-Chi', '2': '2 Shuro-Chi', riven: '5 Riven', '5': '5 Riven' } },
  deepStoneCrypt: { name: 'Deep Stone Crypt', encounters: { cryptsecurity: '1 Security', atraks: '2 Atraks', descent: '3 Descent' } },
  desertPerpetual: { name: 'Desert Perpetual (Epic)', encounters: { koregoseai: '1 KoregosEAI', koregosaei: '2 KoregosAEI' } }
};

const CHANNEL_ENCOUNTERS = {
  d2chests: {
    kingsFall: { ships: 'ships' },
    ghostsDeep: { boss: 'boss', simmumah: 'boss' },
    lastWish: { shurochi: 'shuro-chi', '2': 'shuro-chi' },
    gardenSalvation: { sanctifiedmind: 'sanctified' },
    vaultGlass: { confluxes: 'confluxes' },
    crotasEnd: { abyss: 'abyss', hallway: 'hallway' }
  },
  destiny2checkpoints: {
    rootNightmares: { nezarec: 'nezarec' },
    vowDisciple: { rhulk: 'rhulk' },
    salvationsEdge: { verity: 'verity' }
  }
};

const ACTIVITY_ID_ALIASES = { crotaEnd: 'crotasEnd', deepStoneLegacy: 'deepStoneCrypt' };
const CHEST_TOKENS = new Set(['chest', 'chest1', 'chest2', 'maze', 'wall', 'post-templar']);

function normalizeBungieId(value) {
  if (typeof value !== 'string' || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value)) return '';
  const id = value.trim();
  const match = /^([^#]+)#[0-9]{4}$/u.exec(id);
  if (!match || match[1].trim() !== match[1] || [...match[1]].length > 26) return '';
  return id;
}

function buildQueueCommand(report, bungieId) {
  const player = normalizeBungieId(bungieId);
  if (!player || !report || !CHANNELS.includes(report.login)) return null;

  const difficulty = typeof report.difficultyCode === 'string' ? report.difficultyCode.toLowerCase() : '';
  if (difficulty !== 'n' && difficulty !== 'm') return null;
  if (typeof report.activityId !== 'string' || typeof report.activityCode !== 'string' || typeof report.encounterCode !== 'string') return null;
  const activityId = Object.hasOwn(ACTIVITY_ID_ALIASES, report.activityId) ? ACTIVITY_ID_ALIASES[report.activityId] : report.activityId;
  if (!Object.hasOwn(checkpointActivities, activityId) || checkpointActivities[activityId].activityCode.toLowerCase() !== report.activityCode.toLowerCase()) return null;
  const activity = ACTIVITIES[activityId];
  if (difficulty === 'm' && !activity?.master) return null;

  // Normalize the internal OCR label solely for lookup. Only the fixed token
  // from the operator's table can become part of a message.
  const label = report.encounterCode.toLowerCase().replace(/[ -]/g, '');
  if (report.login === 'soloraidsbot') {
    const solo = SOLO_ACTIVITIES[activityId];
    if (!solo || !Object.hasOwn(solo.encounters, label)) return null;
    return `!queue ${solo.name} ${solo.encounters[label]} ${difficulty.toUpperCase()} ${player}`;
  }
  if (!activity) return null;
  if (report.login === 'd2checkpoints' && activityId === 'vespersHost' && label === 'boss' && difficulty === 'n') {
    return `!queue vh boss n ${player}`;
  }
  if (report.login === 'luckbot9' && activityId === 'lastWish' && label === 'shurochi') {
    return `!queue lw shuro normal ${player}`;
  }
  const channelEncounters = CHANNEL_ENCOUNTERS[report.login]?.[activityId];
  if (channelEncounters && Object.hasOwn(channelEncounters, label)) {
    return `!queue ${activity.code} ${channelEncounters[label]} ${difficulty} ${player}`;
  }
  if (!Object.hasOwn(activity.encounters, label)) return null;
  const encounter = activity.encounters[label];
  if (report.login === 'd2chests' && !CHEST_TOKENS.has(encounter)) return null;
  return `!queue ${activity.code} ${encounter} ${difficulty} ${player}`;
}

module.exports = { CHANNELS, CHANNEL_SOURCES, normalizeBungieId, buildQueueCommand };
