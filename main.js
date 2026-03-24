/*
 * あざらし育成ゲーム 拡張基盤メモ
 *
 * 全体構成:
 * - mainState: セーブ対象の育成データ。魚・満腹・ごきげん・成長などの本編値のみを持つ。
 * - appState: 現在の mode / 開いているパネル / 選択中の機能種別など、画面遷移の責務を持つ。
 * - featureState: 起動中のミニゲームや feature hub の一時状態、共通 result 表示、実行中 definition を持つ。
 * - uiState: 通知・ログ表示・一時 UI 文言など、保存不要の描画専用情報を持つ。
 * - eventRuntime: ランダムイベントのクールダウンと抽選タイマーだけを持つ。
 *
 * 追加手順:
 * 1. 新しいミニゲームは registerMinigame() に definition を渡して registry へ登録する。
 *    createState/start/update/render/finish/cleanup を実装し、main state を直接触らず result を返す。
 * 2. 新しいイベントは registerEvent() で eventRegistry へ登録する。
 *    canTrigger/createPayload/apply/getLogText/cooldownSec/weight or chance を定義する。
 * 3. 本編へ影響を与えたい場合は rewards を返し、必ず resultSystem(processFeatureResult) を経由する。
 * 4. finishMinigame() や applyEventResult() は normalizeResult() -> applyRewardsToMainState() -> appendLogs() の流れで統一する。
 * 5. pendingAction は既存の配置アクション専用のまま維持し、新しい責務は featureState/appState/eventRuntime に分離する。
 */

const SAVE_KEY = 'seal-game-save-v2';
const SAVE_VERSION = 2;
const FEATURE_MODES = Object.freeze({
  MAIN: 'main',
  FEATURE: 'feature',
  MINIGAME: 'minigame',
  MODAL: 'modal'
});
const FEATURE_RESULT_FIELDS = ['fish', 'hunger', 'happiness', 'stamina', 'bond', 'weight', 'growth', 'trainingCount'];
const EVENT_CHECK_INTERVAL = 6;

const PERSONALITY_PRESETS = {
  playful: { label: 'あそび好き', toySpeedBonus: 0.24, toyMoodBonus: 1.2 },
  calm: { label: 'おだやか', toySpeedBonus: 0.08, toyMoodBonus: 0.9 },
  earnest: { label: 'がんばりや', toySpeedBonus: 0.16, toyMoodBonus: 1.05 }
};

function defaultState() {
  return {
    version: SAVE_VERSION,
    lastTick: Date.now(),
    lastStatus: 'のんびりしている',
    fish: 30,
    hunger: 70,
    happiness: 72,
    stamina: 68,
    bond: 20,
    weight: 38,
    growth: 0,
    stage: 0,
    trainingCount: 0,
    personality: 'playful',
    volume: 70,
    showTime: true
  };
}

function createAppState() {
  return {
    mode: FEATURE_MODES.MAIN,
    activePanel: null,
    featureTab: 'minigame'
  };
}

function createFeatureState() {
  return {
    selectedEntryId: null,
    currentEntry: null,
    currentMinigame: null,
    currentMinigameState: null,
    currentMinigameCleanup: null,
    status: 'idle',
    result: null,
    contentCacheKey: '',
    contentBindings: {},
    frameMessage: '遊びたいものを選んでください。'
  };
}

function createUiState() {
  return {
    logs: [],
    notification: '',
    featureContentDirty: true
  };
}

function createEventRuntime() {
  return {
    cooldowns: {},
    checkTimer: 0,
    lastTriggeredAt: 0
  };
}

const foodItems = [
  {
    name: 'こざかな',
    icon: '🐟',
    cost: 5,
    desc: 'まんぷくをしっかり回復。体重は少しだけ増えやすい。',
    hungerGain: 18,
    happinessGain: 4,
    bondGain: 0,
    staminaGain: 0,
    growthGain: 4,
    weightGain: 1.2
  },
  {
    name: 'エビのおやつ',
    icon: '🦐',
    cost: 10,
    desc: 'ごきげん重視。なかよし度も上がるが、体重増加は控えめ。',
    hungerGain: 10,
    happinessGain: 12,
    bondGain: 5,
    staminaGain: 0,
    growthGain: 3,
    weightGain: 0.8
  },
  {
    name: 'ごほうびプレート',
    icon: '🍣',
    cost: 18,
    desc: '特別メニュー。回復も成長も大きいぶん、体重も増えやすい。',
    hungerGain: 20,
    happinessGain: 8,
    bondGain: 3,
    staminaGain: 12,
    growthGain: 7,
    weightGain: 2.4
  }
];

const toyItems = [
  {
    name: 'やわらかボール',
    icon: '⚽',
    desc: '置いた場所までダッシュ。あそぶとごきげんとなかよしが上がる。',
    playStyle: 'chase',
    staminaCost: 10,
    minStamina: 18,
    happinessGain: 11,
    bondGain: 7,
    weightDelta: -1.2,
    growthGain: 2,
    baseSpeedBoost: 1.65
  },
  {
    name: 'すべるパック',
    icon: '🥏',
    desc: '氷の上をシャーッと追いかける。運動量が大きい。',
    playStyle: 'glide',
    staminaCost: 15,
    minStamina: 28,
    happinessGain: 15,
    bondGain: 6,
    weightDelta: -2,
    growthGain: 3,
    baseSpeedBoost: 1.95
  },
  {
    name: 'ふれあいブイ',
    icon: '🛟',
    desc: 'ぷかぷか浮かぶお気に入り。体力が少ない日でも遊びやすい。',
    playStyle: 'snuggle',
    staminaCost: 5,
    minStamina: 10,
    happinessGain: 8,
    bondGain: 11,
    weightDelta: -0.4,
    growthGain: 1,
    baseSpeedBoost: 1.15
  },
  {
    name: 'おやつ入りボール',
    icon: '🎾',
    desc: '追いかけたあとに小さなおやつも楽しめる、欲ばりおもちゃ。',
    playStyle: 'reward',
    staminaCost: 8,
    minStamina: 16,
    happinessGain: 13,
    bondGain: 8,
    weightDelta: 0.3,
    growthGain: 2,
    hungerGain: 6,
    baseSpeedBoost: 1.5
  }
];

const stageThresholds = [
  { growth: 0, minWeight: 20 },
  { growth: 25, minWeight: 28 },
  { growth: 60, minWeight: 34 },
  { growth: 110, minWeight: 40 }
];

const playArea = document.getElementById('playArea');
const sealButton = document.getElementById('sealButton');
const sealShadow = document.getElementById('sealShadow');
const actionDrop = document.getElementById('actionDrop');
const fishValue = document.getElementById('fishValue');
const stageValue = document.getElementById('stageValue');
const statusBubble = document.getElementById('statusBubble');
const timeBadge = document.getElementById('timeBadge');
const hungerBar = document.getElementById('hungerBar');
const happyBar = document.getElementById('happyBar');
const staminaBar = document.getElementById('staminaBar');
const bondBar = document.getElementById('bondBar');
const weightBar = document.getElementById('weightBar');
const hungerValue = document.getElementById('hungerValue');
const happyValue = document.getElementById('happyValue');
const staminaValue = document.getElementById('staminaValue');
const bondValue = document.getElementById('bondValue');
const weightValue = document.getElementById('weightValue');
const foodPanel = document.getElementById('foodPanel');
const toyPanel = document.getElementById('toyPanel');
const settingsPanel = document.getElementById('settingsPanel');
const foodList = document.getElementById('foodList');
const toyList = document.getElementById('toyList');
const timeToggle = document.getElementById('timeToggle');
const volumeSlider = document.getElementById('volumeSlider');
const resetBtn = document.getElementById('resetBtn');
const openFeatureHubBtn = document.getElementById('openFeatureHubBtn');
const openFeatureHubFromSettingsBtn = document.getElementById('openFeatureHubFromSettingsBtn');
const featureFrameOverlay = document.getElementById('featureFrameOverlay');
const featureMenuList = document.getElementById('featureMenuList');
const featureBadge = document.getElementById('featureBadge');
const featureTitle = document.getElementById('featureTitle');
const featureDescription = document.getElementById('featureDescription');
const featureStatus = document.getElementById('featureStatus');
const featureStartBtn = document.getElementById('featureStartBtn');
const featureBackBtn = document.getElementById('featureBackBtn');
const featureCloseBtn = document.getElementById('featureCloseBtn');
const featureContent = document.getElementById('featureContent');
const featureResult = document.getElementById('featureResult');

const ICE_SLIDE_CONFIG = {
  initialSpeed: 180,
  maxSpeed: 260,
  friction: 0.98,
  turnForce: 2.2,
  wallBounceDamping: 0.8,
  sealRadius: 44,
  debugLogInterval: 0.35
};

let mainState = loadState();
let appState = createAppState();
let featureState = createFeatureState();
let uiState = createUiState();
let eventRuntime = createEventRuntime();
let seal = {
  x: 0,
  y: 0,
  targetX: 0,
  targetY: 0,
  mode: 'idle',
  timer: 0,
  speed: 32,
  facing: 1,
  bob: 0,
  actionTarget: null
};
let pendingAction = null;
let placedAction = null;
let iceSlideInput = 0;
let minigameRegistry = Object.create(null);
let eventRegistry = Object.create(null);

const modeHandlers = {
  [FEATURE_MODES.MAIN]: {
    update(dt) {
      tickMainState(dt);
      tickSeal(dt);
    },
    render() {
      renderFeatureFrame();
    }
  },
  [FEATURE_MODES.FEATURE]: {
    update(dt) {
      tickMainState(dt);
      tickSeal(dt);
    },
    render() {
      renderFeatureFrame();
    }
  },
  [FEATURE_MODES.MINIGAME]: {
    update(dt) {
      updateActiveMinigame(dt);
    },
    render() {
      renderFeatureFrame();
      renderActiveMinigame();
    }
  },
  [FEATURE_MODES.MODAL]: {
    update(dt) {
      tickMainState(dt);
      tickSeal(dt);
    },
    render() {
      renderFeatureFrame();
    }
  }
};

init();

function init() {
  registerBuiltInMinigames();
  registerBuiltInEvents();
  placeSealInitially();
  renderFoodList();
  renderToyList();
  ensureFeatureSelection();
  bindEvents();
  applyOfflineProgress();
  updateStage();
  render();
  requestAnimationFrame(loop);
  setInterval(saveState, 5000);
}

function createSystemContext() {
  return {
    mainState,
    appState,
    featureState,
    uiState,
    eventRuntime,
    helpers: {
      finishMinigame,
      cancelMinigame,
      processFeatureResult,
      setFeatureMessage,
      setMode,
      markFeatureContentDirty,
      getCurrentMode,
      isMainMode,
      isMinigameMode
    }
  };
}

function loadState() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return defaultState();
    const parsed = JSON.parse(raw);
    return normalizeLoadedState(parsed);
  } catch {
    return defaultState();
  }
}

function saveState() {
  mainState.version = SAVE_VERSION;
  mainState.lastTick = Date.now();
  localStorage.setItem(SAVE_KEY, JSON.stringify(mainState));
}

function normalizeLoadedState(loaded) {
  const fallback = defaultState();
  if (!loaded || typeof loaded !== 'object') return fallback;
  const normalized = { ...fallback, ...loaded };
  normalized.version = typeof loaded.version === 'number' ? loaded.version : fallback.version;
  return normalized;
}

function applyDelta(targetState, delta) {
  Object.entries(delta).forEach(([key, value]) => {
    if (typeof value !== 'number' || value === 0 || typeof targetState[key] !== 'number') return;
    targetState[key] += value;
  });
}

function applyOfflineProgress() {
  const now = Date.now();
  const elapsedSec = Math.min(60 * 60, Math.max(0, Math.floor((now - mainState.lastTick) / 1000)));
  if (elapsedSec > 5) {
    applyDelta(mainState, buildOfflineDelta(elapsedSec));
    clampState();
    mainState.lastStatus = `おるすばん中に ${Math.floor(elapsedSec / 6)} 秒ぶん すごした`;
  }
  mainState.lastTick = now;
}

function buildOfflineDelta(elapsedSec) {
  return {
    hunger: -(elapsedSec * 0.02),
    happiness: -(elapsedSec * 0.015),
    stamina: elapsedSec * 0.01,
    weight: -(elapsedSec * 0.0018)
  };
}

function bindEvents() {
  document.querySelectorAll('.nav-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.dataset.panel) {
        openPanel(btn.dataset.panel);
        return;
      }
      if (btn.dataset.featureHub === 'true') {
        openFeatureHub();
      }
    });
  });

  document.querySelectorAll('[data-close]').forEach((btn) => {
    btn.addEventListener('click', closePanels);
  });

  [foodPanel, toyPanel, settingsPanel].forEach((panel) => {
    panel.addEventListener('click', (e) => {
      if (e.target === panel) closePanels();
    });
  });

  playArea.addEventListener('click', onPlayAreaClick);
  sealButton.addEventListener('click', petSeal);
  featureStartBtn.addEventListener('click', onFeatureStart);
  featureBackBtn.addEventListener('click', onFeatureBack);
  featureCloseBtn.addEventListener('click', onFeatureBack);
  openFeatureHubFromSettingsBtn.addEventListener('click', () => {
    closePanels();
    openFeatureHub();
  });

  timeToggle.checked = mainState.showTime;
  volumeSlider.value = mainState.volume;

  timeToggle.addEventListener('change', () => {
    mainState.showTime = timeToggle.checked;
    render();
    saveState();
  });

  volumeSlider.addEventListener('input', () => {
    mainState.volume = Number(volumeSlider.value);
    saveState();
  });

  resetBtn.addEventListener('click', () => {
    const ok = confirm('ほんまにリセットする？');
    if (!ok) return;
    mainState = defaultState();
    appState = createAppState();
    featureState = createFeatureState();
    uiState = createUiState();
    eventRuntime = createEventRuntime();
    iceSlideInput = 0;
    clearPendingAction();
    closePanels();
    placeSealInitially();
    ensureFeatureSelection();
    renderFoodList();
    renderToyList();
    render();
    saveState();
  });

  featureFrameOverlay.addEventListener('click', (event) => {
    if (event.target === featureFrameOverlay && !isMinigameMode()) {
      closeFeatureHub();
    }
  });

  window.addEventListener('beforeunload', saveState);
  window.addEventListener('resize', () => {
    placeSealInitially();
    if (featureState.currentMinigame && featureState.currentMinigame.onResize) {
      featureState.currentMinigame.onResize(createMinigameContext(0));
    }
  });
  window.addEventListener('keydown', onWindowKeyDown);
  window.addEventListener('keyup', onWindowKeyUp);
}

function onWindowKeyDown(event) {
  if (!isMinigameMode() || !featureState.currentMinigame || !featureState.currentMinigame.onKeyDown) return;
  featureState.currentMinigame.onKeyDown(createMinigameContext(0), event);
}

function onWindowKeyUp(event) {
  if (!isMinigameMode() || !featureState.currentMinigame || !featureState.currentMinigame.onKeyUp) return;
  featureState.currentMinigame.onKeyUp(createMinigameContext(0), event);
}

function getCurrentMode() {
  return appState.mode;
}

function setMode(modeName) {
  appState.mode = modeName;
  renderFeatureFrame();
}

function isMainMode() {
  return getCurrentMode() === FEATURE_MODES.MAIN;
}

function isMinigameMode() {
  return getCurrentMode() === FEATURE_MODES.MINIGAME;
}

function openPanel(name) {
  closePanels();
  appState.activePanel = name;
  if (name === 'food') {
    renderFoodList();
    foodPanel.classList.add('open');
  }
  if (name === 'toy') {
    renderToyList();
    toyPanel.classList.add('open');
  }
  if (name === 'settings') {
    settingsPanel.classList.add('open');
  }
}

function closePanels() {
  appState.activePanel = null;
  foodPanel.classList.remove('open');
  toyPanel.classList.remove('open');
  settingsPanel.classList.remove('open');
}

function openFeatureHub() {
  closePanels();
  ensureFeatureSelection();
  featureState.status = featureState.result ? 'result' : 'select';
  setFeatureMessage('遊びたい機能を選んで、共通フレームから開始できます。');
  setMode(FEATURE_MODES.FEATURE);
  markFeatureContentDirty();
  renderFeatureFrame();
}

function closeFeatureHub() {
  featureState.status = 'idle';
  featureState.currentEntry = null;
  featureState.currentMinigame = null;
  featureState.currentMinigameState = null;
  featureState.contentBindings = {};
  featureState.contentCacheKey = '';
  setMode(FEATURE_MODES.MAIN);
  renderFeatureFrame();
}

function onFeatureStart() {
  if (!featureState.selectedEntryId) return;
  const entry = getFeatureEntries().find((item) => item.id === featureState.selectedEntryId);
  if (!entry) return;
  if (entry.type === 'minigame') {
    startMinigame(entry.id);
    return;
  }
}

function onFeatureBack() {
  if (isMinigameMode()) {
    cancelMinigame();
    return;
  }
  closeFeatureHub();
}

function ensureFeatureSelection() {
  const entries = getFeatureEntries();
  if (!entries.length) {
    featureState.selectedEntryId = null;
    return;
  }
  if (!entries.some((entry) => entry.id === featureState.selectedEntryId)) {
    featureState.selectedEntryId = entries[0].id;
  }
  featureState.currentEntry = entries.find((entry) => entry.id === featureState.selectedEntryId) || null;
}

function getFeatureEntries() {
  return Object.values(minigameRegistry)
    .map((definition) => ({
      id: definition.id,
      type: 'minigame',
      title: definition.title,
      description: definition.description,
      menuLabel: definition.menuLabel || definition.title,
      badge: definition.badge || 'MINIGAME'
    }));
}

function setFeatureMessage(message) {
  featureState.frameMessage = message;
}

function markFeatureContentDirty() {
  uiState.featureContentDirty = true;
}

function registerMinigame(definition) {
  if (!definition || !definition.id) return;
  minigameRegistry[definition.id] = definition;
  ensureFeatureSelection();
}

function createMinigameContext(dt = 0) {
  return {
    ...createSystemContext(),
    dt,
    minigameState: featureState.currentMinigameState,
    contentRoot: featureContent,
    setInputDirection(value) {
      iceSlideInput = value;
    },
    getInputDirection() {
      return iceSlideInput;
    }
  };
}

function startMinigame(gameId) {
  const definition = minigameRegistry[gameId];
  if (!definition) return;
  closePanels();
  clearPendingAction();
  featureState.selectedEntryId = gameId;
  featureState.currentEntry = getFeatureEntries().find((entry) => entry.id === gameId) || null;
  featureState.currentMinigame = definition;
  featureState.currentMinigameState = definition.createState ? definition.createState(createSystemContext()) : {};
  featureState.result = null;
  featureState.status = 'running';
  featureState.contentBindings = {};
  featureState.contentCacheKey = '';
  setFeatureMessage(`${definition.title} を開始しました。`);
  markFeatureContentDirty();
  setMode(FEATURE_MODES.MINIGAME);
  if (definition.start) {
    definition.start(createMinigameContext(0));
  }
}

function updateActiveMinigame(dt) {
  if (!featureState.currentMinigame || !featureState.currentMinigame.update) return;
  featureState.currentMinigame.update(createMinigameContext(dt));
}

function renderActiveMinigame() {
  if (!featureState.currentMinigame || !featureState.currentMinigame.render) return;
  featureState.currentMinigame.render(createMinigameContext(0));
}

function finishMinigame(result) {
  const definition = featureState.currentMinigame;
  const context = createMinigameContext(0);
  let rawResult = result;
  if (definition && definition.finish) {
    const finished = definition.finish(context, result);
    if (finished) rawResult = finished;
  }
  if (definition && definition.cleanup) {
    definition.cleanup(context);
  }
  featureState.currentMinigame = null;
  featureState.currentMinigameState = null;
  featureState.contentBindings = {};
  featureState.contentCacheKey = '';
  iceSlideInput = 0;
  processFeatureResult(rawResult || { gameId: definition ? definition.id : 'unknown', logs: ['ミニゲームを終了した。'] });
  featureState.status = 'result';
  setFeatureMessage('ミニゲーム結果を本編へ反映しました。');
  setMode(FEATURE_MODES.FEATURE);
  renderFeatureFrame();
  saveState();
}

function cancelMinigame() {
  const definition = featureState.currentMinigame;
  if (definition && definition.cleanup) {
    definition.cleanup(createMinigameContext(0));
  }
  featureState.currentMinigame = null;
  featureState.currentMinigameState = null;
  featureState.contentBindings = {};
  featureState.contentCacheKey = '';
  featureState.status = 'select';
  iceSlideInput = 0;
  setFeatureMessage('ミニゲームを中断して戻りました。');
  setMode(FEATURE_MODES.FEATURE);
  renderFeatureFrame();
}

function registerEvent(definition) {
  if (!definition || !definition.id) return;
  eventRegistry[definition.id] = definition;
}

function tryTriggerRandomEvent() {
  if (!isMainMode() || pendingAction || seal.actionTarget) return null;
  if (mainState.hunger <= 0 || mainState.stamina <= 0) return null;
  const nowSec = Date.now() / 1000;
  const candidates = Object.values(eventRegistry).filter((definition) => {
    const nextAllowedAt = eventRuntime.cooldowns[definition.id] || 0;
    if (nowSec < nextAllowedAt) return false;
    return definition.canTrigger ? definition.canTrigger(mainState, eventRuntime) : true;
  });
  if (!candidates.length) return null;

  const chanceCandidates = candidates.filter((item) => typeof item.chance === 'number');
  for (const definition of chanceCandidates) {
    if (Math.random() < definition.chance) {
      return triggerEvent(definition.id);
    }
  }

  const weighted = candidates.filter((item) => typeof item.weight === 'number' && item.weight > 0);
  if (!weighted.length) return null;
  const totalWeight = weighted.reduce((sum, item) => sum + item.weight, 0);
  let roll = Math.random() * totalWeight;
  for (const definition of weighted) {
    roll -= definition.weight;
    if (roll <= 0) return triggerEvent(definition.id);
  }
  return null;
}

function triggerEvent(eventId, payload) {
  const definition = eventRegistry[eventId];
  if (!definition) return null;
  const createdPayload = payload ?? (definition.createPayload ? definition.createPayload(mainState, eventRuntime) : {});
  const rawResult = definition.apply ? definition.apply(createdPayload, mainState, eventRuntime) : {};
  const eventResult = {
    gameId: `event:${definition.id}`,
    cleared: true,
    score: typeof rawResult.score === 'number' ? rawResult.score : 0,
    rank: rawResult.rank ?? null,
    rewards: rawResult.rewards,
    logs: [
      definition.title,
      definition.getLogText ? definition.getLogText(createdPayload, rawResult) : `${definition.title} が発生した。`,
      ...(Array.isArray(rawResult.logs) ? rawResult.logs : [])
    ],
    meta: {
      type: 'event',
      eventId: definition.id,
      payload: createdPayload,
      ...(rawResult.meta || {})
    }
  };
  return applyEventResult(eventResult, definition);
}

function applyEventResult(eventResult, definition) {
  const nowSec = Date.now() / 1000;
  if (definition) {
    eventRuntime.cooldowns[definition.id] = nowSec + (definition.cooldownSec || 0);
  }
  eventRuntime.lastTriggeredAt = nowSec;
  processFeatureResult(eventResult, { silentResultPanel: true });
  return eventResult;
}

function normalizeResult(rawResult = {}) {
  return {
    gameId: typeof rawResult.gameId === 'string' ? rawResult.gameId : 'unknown',
    cleared: Boolean(rawResult.cleared),
    score: typeof rawResult.score === 'number' ? rawResult.score : 0,
    rank: rawResult.rank ?? null,
    rewards: rawResult.rewards && typeof rawResult.rewards === 'object' ? rawResult.rewards : {},
    logs: Array.isArray(rawResult.logs) ? rawResult.logs.filter((item) => typeof item === 'string' && item) : [],
    meta: rawResult.meta && typeof rawResult.meta === 'object' ? rawResult.meta : {}
  };
}

function applyRewardsToMainState(rewards = {}) {
  const numericDelta = {};
  FEATURE_RESULT_FIELDS.forEach((key) => {
    if (typeof rewards[key] === 'number') {
      numericDelta[key] = rewards[key];
    }
  });
  applyDelta(mainState, numericDelta);
  if (rewards.items && typeof rewards.items === 'object') {
    const fishDelta = typeof rewards.items.fish === 'number' ? rewards.items.fish : 0;
    if (fishDelta) {
      applyDelta(mainState, { fish: fishDelta });
    }
  }
  updateStage();
  clampState();
  renderFoodList();
  renderToyList();
}

function appendLogs(logs = []) {
  if (!logs.length) return;
  uiState.logs.push(...logs);
  uiState.logs = uiState.logs.slice(-20);
  uiState.notification = logs[logs.length - 1];
  mainState.lastStatus = logs[logs.length - 1];
}

function processFeatureResult(result, options = {}) {
  const normalized = normalizeResult(result);
  applyRewardsToMainState(normalized.rewards);
  appendLogs(normalized.logs);
  if (!options.silentResultPanel) {
    featureState.result = normalized;
  }
  saveState();
  return normalized;
}

function registerBuiltInMinigames() {
  registerMinigame({
    id: 'training-touch',
    title: 'さかなタッチ',
    description: '5回タップで成功する既存トレーニングを、共通ミニゲーム基盤へ移行したものです。',
    menuLabel: 'さかなタッチ',
    badge: 'MINIGAME',
    createState() {
      return { taps: 0, needed: 5, finished: false };
    },
    start() {
      setFeatureMessage('動くさかなを5回タップすると成功です。');
    },
    render(context) {
      const { minigameState, contentRoot } = context;
      if (!minigameState) return;
      const cacheKey = 'training-touch';
      if (featureState.contentCacheKey !== cacheKey || uiState.featureContentDirty) {
        contentRoot.innerHTML = `
          <div class="feature-minigame feature-training-card">
            <div class="feature-minigame-copy">うごく さかな を 5回 タップしよう</div>
            <button class="feature-training-target" id="featureTrainingTarget" type="button">🐟</button>
            <div class="feature-minigame-progress" id="featureTrainingProgress"></div>
          </div>
        `;
        const target = document.getElementById('featureTrainingTarget');
        const progress = document.getElementById('featureTrainingProgress');
        target.addEventListener('click', () => {
          if (minigameState.finished) return;
          minigameState.taps += 1;
          target.animate([{ transform: 'scale(1)' }, { transform: 'scale(0.92)' }, { transform: 'scale(1)' }], { duration: 120 });
          markFeatureContentDirty();
          if (minigameState.taps >= minigameState.needed) {
            minigameState.finished = true;
            finishMinigame({
              gameId: 'training-touch',
              cleared: true,
              score: 100,
              rank: 'A',
              rewards: buildTrainingSuccessRewards(),
              logs: ['さかなタッチに成功した。', 'トレーニングでちょっと たくましく なった。'],
              meta: { taps: minigameState.taps }
            });
          }
        });
        featureState.contentBindings = { progress };
        featureState.contentCacheKey = cacheKey;
      }
      if (featureState.contentBindings.progress) {
        featureState.contentBindings.progress.textContent = `${minigameState.taps} / ${minigameState.needed}`;
      }
      uiState.featureContentDirty = false;
    },
    cleanup() {
      featureContent.innerHTML = '';
    }
  });

  registerMinigame({
    id: 'dummy-wait',
    title: 'おひるねタイマー',
    description: '10秒待つだけのダミーミニゲームです。共通開始 / update / finish / result の動作確認用です。',
    menuLabel: 'おひるねタイマー',
    badge: 'SAMPLE',
    createState() {
      return { elapsed: 0, duration: 10, cleared: false };
    },
    start() {
      setFeatureMessage('10秒たつと自動で終了します。');
    },
    update(context) {
      const { dt, minigameState } = context;
      if (!minigameState || minigameState.cleared) return;
      minigameState.elapsed += dt;
      if (minigameState.elapsed >= minigameState.duration) {
        minigameState.cleared = true;
        finishMinigame({
          gameId: 'dummy-wait',
          cleared: true,
          score: 100,
          rank: 'A',
          rewards: { happiness: 5, stamina: 3 },
          logs: ['おひるねタイマーが終わった。', 'のんびり休んで ごきげんが上がった。'],
          meta: { elapsedSec: minigameState.duration }
        });
      }
    },
    render(context) {
      const { minigameState, contentRoot } = context;
      if (!minigameState) return;
      const remaining = Math.max(0, minigameState.duration - minigameState.elapsed);
      const progress = clamp((minigameState.elapsed / minigameState.duration) * 100, 0, 100);
      contentRoot.innerHTML = `
        <div class="feature-minigame feature-wait-card">
          <div class="feature-minigame-emoji">🛌</div>
          <div class="feature-minigame-copy">10秒たつとクリア</div>
          <div class="feature-progress-bar"><span style="width:${progress}%"></span></div>
          <div class="feature-minigame-progress">残り ${remaining.toFixed(1)} 秒</div>
        </div>
      `;
      uiState.featureContentDirty = false;
    },
    cleanup() {
      featureContent.innerHTML = '';
    }
  });

  registerMinigame({
    id: 'ice-slide',
    title: '氷スライド テスト',
    description: '既存の氷スライド試験機能を、共通ミニゲーム登録基盤に載せ替えたものです。←/→ またはマウス左右で曲がれます。',
    menuLabel: '氷スライド',
    badge: 'LEGACY',
    createState() {
      return createIceSlideState();
    },
    start(context) {
      initializeIceSlideState(context.minigameState);
      setFeatureMessage('← / → キー、または左右クリックで旋回できます。');
    },
    update(context) {
      updateIceSlide(context.dt, context.minigameState);
    },
    render(context) {
      const { minigameState, contentRoot } = context;
      if (!minigameState) return;
      const cacheKey = 'ice-slide';
      if (featureState.contentCacheKey !== cacheKey || uiState.featureContentDirty) {
        contentRoot.innerHTML = `
          <div class="feature-minigame feature-ice-card">
            <div class="feature-ice-arena" id="featureIceArena">
              <div class="feature-ice-seal" id="featureIceSeal">🦭</div>
            </div>
            <div class="feature-minigame-progress" id="featureIceDebug"></div>
          </div>
        `;
        const arena = document.getElementById('featureIceArena');
        const sealEl = document.getElementById('featureIceSeal');
        const debug = document.getElementById('featureIceDebug');
        arena.addEventListener('contextmenu', (event) => {
          if (!isMinigameMode()) return;
          event.preventDefault();
        });
        arena.addEventListener('mousedown', (event) => {
          if (!isMinigameMode()) return;
          event.preventDefault();
          if (event.button === 0) iceSlideInput = -1;
          if (event.button === 2) iceSlideInput = 1;
        });
        arena.addEventListener('mouseup', (event) => {
          if (!isMinigameMode()) return;
          if ((event.button === 0 && iceSlideInput === -1) || (event.button === 2 && iceSlideInput === 1)) {
            iceSlideInput = 0;
          }
        });
        arena.addEventListener('mouseleave', () => {
          iceSlideInput = 0;
        });
        featureState.contentBindings = { arena, sealEl, debug };
        featureState.contentCacheKey = cacheKey;
        initializeIceSlideState(minigameState);
      }
      renderIceSlide(minigameState);
      uiState.featureContentDirty = false;
    },
    finish(_context, result) {
      return result || {
        gameId: 'ice-slide',
        cleared: false,
        score: 0,
        rank: null,
        rewards: {},
        logs: ['氷スライドテストを終了した。'],
        meta: {}
      };
    },
    cleanup() {
      iceSlideInput = 0;
      featureContent.innerHTML = '';
    },
    onKeyDown(_context, event) {
      if (event.key === 'ArrowLeft') {
        iceSlideInput = -1;
        event.preventDefault();
      }
      if (event.key === 'ArrowRight') {
        iceSlideInput = 1;
        event.preventDefault();
      }
      if (event.key === 'Escape') {
        cancelMinigame();
      }
    },
    onKeyUp(_context, event) {
      if ((event.key === 'ArrowLeft' && iceSlideInput === -1) || (event.key === 'ArrowRight' && iceSlideInput === 1)) {
        iceSlideInput = 0;
        event.preventDefault();
      }
    },
    onResize(context) {
      if (featureState.currentMinigame?.id !== 'ice-slide') return;
      initializeIceSlideState(context.minigameState);
      renderIceSlide(context.minigameState);
    }
  });
}

function registerBuiltInEvents() {
  registerEvent({
    id: 'relaxing-breeze',
    title: 'ランダムイベント',
    chance: 0.12,
    cooldownSec: 45,
    canTrigger(state) {
      return state.happiness < 98;
    },
    createPayload() {
      return { bonus: 4 + Math.floor(Math.random() * 3) };
    },
    apply(payload) {
      return {
        rewards: { happiness: payload.bonus },
        logs: ['のんびりしている。'],
        meta: { bonus: payload.bonus }
      };
    },
    getLogText(payload) {
      return `潮風が気持ちよくて、しあわせが ${payload.bonus} 上がった。`;
    }
  });
}

function createIceSlideState() {
  return {
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    angle: 0,
    debugTimer: 0
  };
}

function initializeIceSlideState(state) {
  const arena = featureState.contentBindings.arena;
  if (!state || !arena) return;
  const arenaRect = arena.getBoundingClientRect();
  state.x = arenaRect.width * 0.5;
  state.y = arenaRect.height * 0.58;
  state.angle = -Math.PI / 2;
  state.vx = Math.cos(state.angle) * ICE_SLIDE_CONFIG.initialSpeed;
  state.vy = Math.sin(state.angle) * ICE_SLIDE_CONFIG.initialSpeed;
  state.debugTimer = 0;
}

function updateIceSlide(dt, state) {
  if (!state || !featureState.contentBindings.arena) return;
  const turnAmount = iceSlideInput * ICE_SLIDE_CONFIG.turnForce * dt;
  const rotatedVelocity = rotateVector(state.vx, state.vy, turnAmount);
  state.vx = rotatedVelocity.x;
  state.vy = rotatedVelocity.y;

  const frictionFactor = Math.pow(ICE_SLIDE_CONFIG.friction, dt * 60);
  state.vx *= frictionFactor;
  state.vy *= frictionFactor;

  const speed = Math.hypot(state.vx, state.vy);
  const clampedSpeed = Math.min(ICE_SLIDE_CONFIG.maxSpeed, speed);
  if (speed > 0 && clampedSpeed !== speed) {
    const ratio = clampedSpeed / speed;
    state.vx *= ratio;
    state.vy *= ratio;
  }

  state.x += state.vx * dt;
  state.y += state.vy * dt;
  reflectIceSlideOnWalls(state);

  if (Math.hypot(state.vx, state.vy) > 0.001) {
    state.angle = Math.atan2(state.vy, state.vx);
  }

  state.debugTimer -= dt;
  if (state.debugTimer <= 0) {
    state.debugTimer = ICE_SLIDE_CONFIG.debugLogInterval;
  }
}

function reflectIceSlideOnWalls(state) {
  const arena = featureState.contentBindings.arena;
  if (!arena) return;
  const arenaRect = arena.getBoundingClientRect();
  const minX = ICE_SLIDE_CONFIG.sealRadius;
  const minY = ICE_SLIDE_CONFIG.sealRadius;
  const maxX = arenaRect.width - ICE_SLIDE_CONFIG.sealRadius;
  const maxY = arenaRect.height - ICE_SLIDE_CONFIG.sealRadius;
  let bounced = false;

  if (state.x <= minX) {
    state.x = minX;
    state.vx = Math.abs(state.vx);
    bounced = true;
  } else if (state.x >= maxX) {
    state.x = maxX;
    state.vx = -Math.abs(state.vx);
    bounced = true;
  }

  if (state.y <= minY) {
    state.y = minY;
    state.vy = Math.abs(state.vy);
    bounced = true;
  } else if (state.y >= maxY) {
    state.y = maxY;
    state.vy = -Math.abs(state.vy);
    bounced = true;
  }

  if (bounced) {
    state.vx *= ICE_SLIDE_CONFIG.wallBounceDamping;
    state.vy *= ICE_SLIDE_CONFIG.wallBounceDamping;
  }
}

function renderIceSlide(state) {
  const { sealEl, debug } = featureState.contentBindings;
  if (!state || !sealEl || !debug) return;
  sealEl.style.left = `${state.x - 30}px`;
  sealEl.style.top = `${state.y - 30}px`;
  sealEl.style.transform = `rotate(${state.angle + Math.PI / 2}rad)`;
  debug.textContent = `speed ${Math.round(Math.hypot(state.vx, state.vy))} / ← → で旋回 / Escでもどる`;
}

function rotateVector(vx, vy, angle) {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return {
    x: vx * cos - vy * sin,
    y: vx * sin + vy * cos
  };
}

function renderFeatureFrame() {
  const shouldOpen = getCurrentMode() !== FEATURE_MODES.MAIN;
  featureFrameOverlay.classList.toggle('open', shouldOpen);
  if (!shouldOpen) {
    featureContent.innerHTML = '';
    featureResult.innerHTML = '<p>ここに結果が表示されます。</p>';
    return;
  }

  ensureFeatureSelection();
  const entries = getFeatureEntries();
  featureMenuList.innerHTML = '';
  entries.forEach((entry) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'feature-menu-btn';
    button.classList.toggle('is-selected', entry.id === featureState.selectedEntryId);
    button.innerHTML = `<strong>${entry.menuLabel}</strong><span>${entry.badge}</span>`;
    button.addEventListener('click', () => {
      featureState.selectedEntryId = entry.id;
      featureState.currentEntry = entry;
      featureState.status = 'select';
      featureState.result = null;
      featureState.contentBindings = {};
      featureState.contentCacheKey = '';
      setFeatureMessage(`${entry.title} を選びました。`);
      markFeatureContentDirty();
      renderFeatureFrame();
    });
    featureMenuList.appendChild(button);
  });

  const selected = entries.find((entry) => entry.id === featureState.selectedEntryId) || null;
  featureState.currentEntry = selected;
  featureBadge.textContent = selected ? selected.badge : 'FEATURE';
  featureTitle.textContent = selected ? selected.title : '機能はまだありません';
  featureDescription.textContent = selected ? selected.description : '登録された機能がありません。';
  featureStatus.textContent = featureState.frameMessage;
  featureStartBtn.disabled = !selected || isMinigameMode();
  featureStartBtn.textContent = isMinigameMode() ? '実行中' : '開始';
  featureBackBtn.textContent = isMinigameMode() ? '中断 / 戻る' : '戻る';

  if (!isMinigameMode() && featureState.status !== 'result') {
    featureContent.innerHTML = `
      <div class="feature-placeholder">
        <div class="feature-placeholder-icon">🎮</div>
        <p>左のメニューからミニゲームを選んで「開始」を押してください。</p>
      </div>
    `;
  }

  renderFeatureResult();
}

function renderFeatureResult() {
  const result = featureState.result;
  if (!result) {
    featureResult.innerHTML = '<p>ここに結果が表示されます。</p>';
    return;
  }
  const rewards = Object.entries(result.rewards || {})
    .filter(([, value]) => typeof value === 'number' && value !== 0)
    .map(([key, value]) => `<li>${key}: ${value > 0 ? '+' : ''}${formatNumber(value)}</li>`)
    .join('');
  const logs = result.logs.map((log) => `<li>${log}</li>`).join('');
  featureResult.innerHTML = `
    <div class="feature-result-card">
      <div class="feature-result-head">
        <strong>${result.gameId}</strong>
        <span>${result.cleared ? 'クリア' : '終了'}</span>
      </div>
      <div class="feature-result-score">score: ${result.score}${result.rank ? ` / rank: ${result.rank}` : ''}</div>
      <div class="feature-result-columns">
        <div>
          <h4>報酬</h4>
          <ul>${rewards || '<li>なし</li>'}</ul>
        </div>
        <div>
          <h4>ログ</h4>
          <ul>${logs || '<li>なし</li>'}</ul>
        </div>
      </div>
    </div>
  `;
}

function formatNumber(value) {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function renderFoodList() {
  renderActionList(foodList, foodItems, 'food');
}

function renderToyList() {
  renderActionList(toyList, toyItems, 'toy');
}

function renderActionList(container, items, kind) {
  container.innerHTML = '';
  items.forEach((item, index) => {
    const card = document.createElement('div');
    card.className = 'option-card';
    const canUse = canUseAction(kind, item);
    const isSelected = pendingAction && pendingAction.kind === kind && pendingAction.index === index && !placedAction;
    const buttonLabel = isSelected ? 'えらび中' : kind === 'food' ? 'あげる' : 'あそぶ';
    const hint = kind === 'food'
      ? `必要なおさかな: ${item.cost} / 体重変化: +${item.weightGain.toFixed(1)}`
      : `必要たいりょく: ${item.minStamina} / 体重変化: ${item.weightDelta} / ${getToyStyleLabel(item.playStyle)}`;
    card.innerHTML = `
      <div>
        <h4>${item.icon} ${item.name}</h4>
        <p>${item.desc}<br>${hint}</p>
      </div>
      <button class="action-btn" ${canUse ? '' : 'disabled'} data-action-kind="${kind}" data-action-index="${index}">${buttonLabel}</button>
    `;
    container.appendChild(card);
  });

  container.querySelectorAll('[data-action-kind]').forEach((btn) => {
    btn.addEventListener('click', () => prepareActionPlacement(btn.dataset.actionKind, Number(btn.dataset.actionIndex)));
  });
}

function canUseAction(kind, item) {
  if (kind === 'food') return mainState.fish >= item.cost;
  return mainState.stamina >= Math.max(8, item.minStamina - 8);
}

function prepareActionPlacement(kind, index) {
  if (!isMainMode()) return;
  const item = kind === 'food' ? foodItems[index] : toyItems[index];
  if (!item || !canUseAction(kind, item)) return;
  pendingAction = { kind, index, item };
  placedAction = null;
  playArea.dataset.dropLabel = kind === 'food'
    ? `${item.name} を落としたい場所をタップ`
    : getToyDropLabel(item);
  mainState.lastStatus = kind === 'food'
    ? `${item.name} を どこに落とすか 選んでいる`
    : getToyReadyStatus(item);
  renderFoodList();
  renderToyList();
  closePanels();
  render();
}

function onPlayAreaClick(event) {
  if (!pendingAction || placedAction) return;
  if (event.target.closest('.stats')) return;
  if (event.target.closest('.seal')) return;
  const rect = playArea.getBoundingClientRect();
  const x = clampActionX(event.clientX - rect.left, rect.width);
  const y = clampActionY(event.clientY - rect.top, rect.height);
  placePendingActionAt(x, y);
}

function placePendingActionAt(x, y) {
  if (!pendingAction) return;
  placedAction = { x, y };
  actionDrop.textContent = pendingAction.item.icon;
  actionDrop.dataset.label = pendingAction.item.name;
  actionDrop.classList.add('visible');
  updateActionDropPosition();

  seal.actionTarget = { x, y };
  seal.targetX = x;
  seal.targetY = y + 40;
  seal.facing = x < seal.x ? -1 : 1;
  setSealMode('walk', pendingAction.kind === 'toy' ? 7 : 6);
  mainState.lastStatus = pendingAction.kind === 'food'
    ? `${pendingAction.item.name} を 見つけて てくてく 向かっている`
    : getToyChaseStatus(pendingAction.item);
  render();
  saveState();
}

function getResolvedAction() {
  if (!pendingAction || !placedAction) return null;
  return {
    kind: pendingAction.kind,
    index: pendingAction.index,
    item: pendingAction.item,
    x: placedAction.x,
    y: placedAction.y
  };
}

function canApplyAction(action, currentState) {
  if (!action) return false;
  if (action.kind === 'food') return currentState.fish >= action.item.cost;
  return currentState.stamina >= action.item.minStamina;
}

function buildActionDelta(action, currentState) {
  if (!action) return {};
  if (action.kind === 'food') {
    if (!canApplyAction(action, currentState)) return {};
    return {
      fish: -action.item.cost,
      ...buildFoodDelta(action.item)
    };
  }
  if (!canApplyAction(action, currentState)) {
    return buildToyTiredDelta();
  }
  const staminaFactor = action.item.playStyle === 'snuggle'
    ? 1
    : currentState.stamina < action.item.minStamina + 12 ? 0.75 : 1;
  return buildToyDelta(action.item, staminaFactor);
}

function buildActionResult(action, currentState) {
  if (!action) return null;
  if (action.kind === 'food' && !canApplyAction(action, currentState)) {
    return {
      delta: {},
      statusText: 'おさかなが 足りなくて ごはんを 用意できなかった',
      floatText: null,
      sealMode: null,
      duration: 0
    };
  }
  if (action.kind === 'toy' && !canApplyAction(action, currentState)) {
    return {
      delta: buildActionDelta(action, currentState),
      statusText: `${action.item.name} は 気になるけれど、つかれていて 今日はのんびりしたいみたい`,
      floatText: 'つかれぎみ',
      sealMode: 'sit',
      duration: 1.8
    };
  }
  return action.kind === 'food'
    ? buildFoodActionResult(action, currentState)
    : buildToyActionResult(action, currentState);
}

function buildFoodActionResult(action, currentState) {
  return {
    delta: buildActionDelta(action, currentState),
    statusText: `${action.item.name} を 見つけて その場でもぐもぐ 食べた`,
    floatText: `+${action.item.name}`,
    sealMode: 'eat',
    duration: 2.2
  };
}

function buildToyActionResult(action, currentState) {
  return {
    delta: buildActionDelta(action, currentState),
    statusText: getToyResultStatus(action.item),
    floatText: getToyFloatText(action.item),
    sealMode: 'idle',
    duration: 1.6
  };
}

function applyResult(result) {
  if (!result) return;
  applyDelta(mainState, result.delta || {});
  if (typeof result.statusText === 'string') mainState.lastStatus = result.statusText;
  if (result.floatText) spawnFloatText(null, null, result.floatText);
  if (result.sealMode) setSealMode(result.sealMode, result.duration);
}

function resolvePendingAction() {
  const action = getResolvedAction();
  if (!action || !seal.actionTarget) return;
  if (pendingAction.kind === 'food') {
    resolveFoodAction(action);
  } else {
    resolveToyAction(action);
  }
}

function resolveFoodAction(action) {
  if (!canApplyAction(action, mainState)) {
    applyResult(buildActionResult(action, mainState));
    clearPendingAction();
    renderFoodList();
    render();
    return;
  }
  applyResult(buildActionResult(action, mainState));
  finalizeResolvedAction();
}

function resolveToyAction(action) {
  applyResult(buildActionResult(action, mainState));
  finalizeResolvedAction();
}

function buildFoodDelta(item) {
  return {
    hunger: item.hungerGain,
    happiness: item.happinessGain,
    bond: item.bondGain,
    stamina: item.staminaGain,
    growth: item.growthGain,
    weight: item.weightGain
  };
}

function buildToyTiredDelta() {
  return { happiness: 2 };
}

function buildToyDelta(item, staminaFactor) {
  return {
    happiness: item.happinessGain * staminaFactor,
    bond: item.bondGain * staminaFactor,
    stamina: -item.staminaCost,
    weight: item.weightDelta,
    growth: item.growthGain,
    hunger: item.hungerGain || 0
  };
}

function finalizeResolvedAction() {
  mainState.weight = clamp(mainState.weight, 16, 80);
  updateStage();
  clampState();
  clearPendingAction();
  renderFoodList();
  renderToyList();
  render();
  saveState();
}

function clearPendingAction() {
  pendingAction = null;
  placedAction = null;
  seal.actionTarget = null;
  actionDrop.classList.remove('visible');
  actionDrop.dataset.label = '';
  playArea.classList.remove('is-drop-mode');
  playArea.dataset.dropLabel = '';
}

function updateActionDropPosition() {
  if (!pendingAction || !placedAction) return;
  actionDrop.style.left = `${placedAction.x - 32}px`;
  actionDrop.style.top = `${placedAction.y - 32}px`;
}

function petSeal(e) {
  if (!isMainMode()) return;
  if (pendingAction && !placedAction) return;
  applyDelta(mainState, buildPetDelta());
  if (mainState.happiness > 80) mainState.fish += 2;
  mainState.lastStatus = randomFrom([
    'うれしそうに こちらを見ている',
    'ぷにっとして ごきげん',
    'しっぽを ぱたぱた している',
    'なでられて まんぞくそう'
  ]);
  updateStage();
  clampState();
  sealButton.classList.add('is-pet');
  setTimeout(() => sealButton.classList.remove('is-pet'), 180);
  spawnFloatText(e ? e.clientX : null, e ? e.clientY : null, '+なかよし');
  render();
  saveState();
}

function buildPetDelta() {
  return {
    happiness: 4,
    bond: 2,
    stamina: -1,
    growth: 1
  };
}

function buildTrainingSuccessRewards() {
  return {
    stamina: 10,
    happiness: 6,
    bond: 6,
    growth: 4,
    trainingCount: 1,
    weight: -0.8
  };
}

function updateStage() {
  let nextStage = 0;
  for (let i = 0; i < stageThresholds.length; i += 1) {
    const threshold = stageThresholds[i];
    if (mainState.growth >= threshold.growth && mainState.weight >= threshold.minWeight) {
      nextStage = i;
    }
  }
  mainState.stage = nextStage;
}

function clampState() {
  mainState.hunger = clamp(mainState.hunger, 0, 100);
  mainState.happiness = clamp(mainState.happiness, 0, 100);
  mainState.stamina = clamp(mainState.stamina, 0, 100);
  mainState.bond = clamp(mainState.bond, 0, 100);
  mainState.weight = clamp(mainState.weight, 16, 80);
  mainState.fish = Math.max(0, Math.floor(mainState.fish));
  mainState.trainingCount = Math.max(0, Math.floor(mainState.trainingCount));
}

function placeSealInitially() {
  const area = playArea.getBoundingClientRect();
  seal.x = Math.max(area.width * 0.74, 420);
  seal.y = area.height * 0.78;
  seal.targetX = seal.x;
  seal.targetY = seal.y;
  updateSealPosition();
  if (placedAction) {
    placedAction.x = clampActionX(placedAction.x, area.width);
    placedAction.y = clampActionY(placedAction.y, area.height);
    updateActionDropPosition();
  }
}

let lastTime = performance.now();
function loop(now) {
  const dt = Math.min(0.05, (now - lastTime) / 1000);
  lastTime = now;
  const handler = modeHandlers[getCurrentMode()] || modeHandlers[FEATURE_MODES.MAIN];
  handler.update(dt);
  render();
  handler.render();
  requestAnimationFrame(loop);
}

function tickMainState(dt) {
  applyDelta(mainState, buildPassiveStateDelta(dt));
  applyPassiveStateBonuses(dt);
  eventRuntime.checkTimer += dt;
  if (eventRuntime.checkTimer >= EVENT_CHECK_INTERVAL) {
    eventRuntime.checkTimer = 0;
    tryTriggerRandomEvent();
  }
  clampState();
  updateTimeTheme();
}

function buildPassiveStateDelta(dt) {
  return {
    hunger: -(dt * 0.65),
    happiness: -(dt * 0.14),
    stamina: dt * (seal.mode === 'sleep' ? 2.2 : 0.22),
    weight: -(dt * (seal.mode === 'walk' ? 0.01 : 0.003))
  };
}

function applyPassiveStateBonuses(dt) {
  if (mainState.hunger < 28) mainState.happiness -= dt * 0.2;
  if (mainState.happiness > 78) mainState.fish += dt * 0.7;
  if (mainState.bond > 60 && Math.random() < dt * 0.08) mainState.fish += 1;
}

function tickSeal(dt) {
  seal.timer -= dt;
  seal.bob += dt * 4;
  if (seal.timer <= 0) chooseNextSealAction();
  if (seal.mode === 'walk') {
    updateWalkingSeal(dt);
  }
  updateSealPosition();
}

function updateWalkingSeal(dt) {
  const chasingAction = Boolean(seal.actionTarget);
  const dx = seal.targetX - seal.x;
  const dy = seal.targetY - seal.y;
  const distance = Math.hypot(dx, dy);
  const facingSource = Math.abs(dx) > 0.5 ? dx : seal.facing;
  seal.facing = Math.sign(facingSource) || 1;
  const travel = seal.speed * getMoveSpeedScale(chasingAction) * dt;
  if (distance <= travel || distance < 1) {
    settleSealAtDestination();
    return;
  }
  seal.x += (dx / distance) * travel;
  seal.y += (dy / distance) * travel;
}

function settleSealAtDestination() {
  seal.x = seal.targetX;
  seal.y = seal.targetY;
  if (seal.actionTarget) {
    resolvePendingAction();
  } else {
    setSealMode('idle', 1 + Math.random() * 2);
  }
}

function chooseNextSealAction() {
  if (seal.actionTarget && pendingAction) {
    seal.targetX = seal.actionTarget.x;
    seal.targetY = seal.actionTarget.y + 40;
    setSealMode('walk', pendingAction.kind === 'toy' ? 4.8 : 4);
    mainState.lastStatus = pendingAction.kind === 'toy'
      ? `${pendingAction.item.name} を 追いかけて ダッシュしている`
      : `${pendingAction.item.name} に まっすぐ 向かっている`;
    return;
  }
  if (seal.mode === 'eat') {
    setSealMode('idle', 1.4);
    return;
  }

  const sleepy = mainState.stamina < 25;
  const hungry = mainState.hunger < 25;
  const lively = mainState.happiness > 70;
  const roll = Math.random();

  if (sleepy && roll < 0.45) {
    setSealMode('sleep', 3 + Math.random() * 3);
    mainState.lastStatus = 'すやすや 眠っている';
    return;
  }
  if (hungry && roll < 0.4) {
    setSealMode('sit', 2 + Math.random() * 2);
    mainState.lastStatus = 'おなかが すいて ちょっと ぼんやり';
    return;
  }
  if (lively && roll < 0.6) {
    seal.targetX = randomSealX();
    seal.targetY = seal.y;
    setSealMode('walk', 2 + Math.random() * 3);
    mainState.lastStatus = randomFrom([
      'のそのそ 歩きまわっている',
      '楽しそうに うろうろ している',
      '氷の上を すべるように 動いた'
    ]);
    return;
  }
  if (roll < 0.5) {
    setSealMode('idle', 1.5 + Math.random() * 2.5);
    mainState.lastStatus = randomFrom([
      'のんびりしている',
      'こちらを じっと 見ている',
      '気ままに ごろごろ している'
    ]);
  } else {
    seal.targetX = randomSealX();
    seal.targetY = seal.y;
    setSealMode('walk', 2 + Math.random() * 3);
    mainState.lastStatus = 'てくてく 歩いている';
  }
}

function setSealMode(mode, duration) {
  seal.mode = mode;
  seal.timer = duration;
}

function randomSealX() {
  const area = playArea.getBoundingClientRect();
  const minX = Math.max(360, area.width * 0.55);
  const maxX = Math.max(minX + 20, area.width - 100);
  return clamp(minX + Math.random() * (maxX - minX), minX, maxX);
}

function updateSealPosition() {
  const baseY = seal.y + Math.sin(seal.bob) * (seal.mode === 'walk' ? 4 : 1);
  const scale = [0.8, 0.92, 1.02, 1.12][mainState.stage] || 1;
  const rotation = seal.mode === 'sleep' ? -7 : seal.mode === 'sit' ? -3 : 0;
  const facingScale = seal.facing === -1 ? -1 : 1;
  sealButton.style.left = `${seal.x - 74}px`;
  sealButton.style.top = `${baseY - 74}px`;
  sealButton.style.transform = `scale(${facingScale * scale}, ${scale}) rotate(${rotation}deg)`;
  sealShadow.style.left = `${seal.x - 60}px`;
  sealShadow.style.top = `${seal.y + 48}px`;
  sealShadow.style.width = `${118 * scale}px`;
  sealShadow.style.opacity = seal.mode === 'walk' ? '0.13' : '0.18';
  sealButton.classList.toggle('is-sleepy', mainState.stamina < 25 || seal.mode === 'sleep');
}

function updateTimeTheme() {
  const hour = new Date().getHours();
  const isNight = hour < 6 || hour >= 18;
  document.body.classList.toggle('night', isNight);
  timeBadge.textContent = isNight ? 'よる' : 'ひる';
}

function render() {
  fishValue.textContent = Math.floor(mainState.fish);
  stageValue.textContent = getStageLabel();
  statusBubble.textContent = mainState.lastStatus;
  hungerBar.style.width = `${mainState.hunger}%`;
  happyBar.style.width = `${mainState.happiness}%`;
  staminaBar.style.width = `${mainState.stamina}%`;
  bondBar.style.width = `${mainState.bond}%`;
  weightBar.style.width = `${mapWeightToPercent(mainState.weight)}%`;
  hungerValue.textContent = Math.floor(mainState.hunger);
  happyValue.textContent = Math.floor(mainState.happiness);
  staminaValue.textContent = Math.floor(mainState.stamina);
  bondValue.textContent = Math.floor(mainState.bond);
  weightValue.textContent = mainState.weight.toFixed(1);
  timeBadge.style.display = mainState.showTime ? 'block' : 'none';
  playArea.classList.toggle('is-drop-mode', Boolean(pendingAction && !placedAction));
}

function spawnFloatText(clientX, clientY, text) {
  const rect = playArea.getBoundingClientRect();
  const el = document.createElement('div');
  el.className = 'float-text';
  el.textContent = text;
  const x = clientX ? clientX - rect.left : seal.x;
  const y = clientY ? clientY - rect.top : seal.y;
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
  playArea.appendChild(el);
  setTimeout(() => el.remove(), 1000);
}

function getMoveSpeedScale(chasingAction) {
  if (!chasingAction) {
    return mainState.hunger < 25 ? 0.55 : mainState.happiness > 70 ? 1.2 : 1;
  }
  if (!pendingAction || pendingAction.kind !== 'toy') {
    return 1.45;
  }
  return getToySpeedMultiplier();
}

function getToySpeedMultiplier() {
  const personality = PERSONALITY_PRESETS[mainState.personality] || PERSONALITY_PRESETS.playful;
  const trainingBonus = Math.min(0.3, mainState.trainingCount * 0.03);
  const playStyleBonus = { chase: 0, glide: 0.18, snuggle: -0.15, reward: 0.08 };
  const styleBonus = playStyleBonus[pendingAction.item.playStyle] || 0;
  return toyItems[pendingAction.index].baseSpeedBoost + personality.toySpeedBonus + trainingBonus + styleBonus;
}

function getToyStyleLabel(playStyle) {
  return ({ chase: '追いかけ', glide: 'すべりあそび', snuggle: 'ふれあい', reward: 'ごほうび付き' })[playStyle] || 'あそび';
}

function getToyDropLabel(item) {
  return ({
    chase: `${item.name} を転がしたい場所をタップ`,
    glide: `${item.name} をすべらせたい場所をタップ`,
    snuggle: `${item.name} を置きたい場所をタップ`,
    reward: `${item.name} を投げたい場所をタップ`
  })[item.playStyle] || `${item.name} を置きたい場所をタップ`;
}

function getToyReadyStatus(item) {
  return ({
    chase: `${item.name} を どこで遊ぶか 選んでいる`,
    glide: `${item.name} ですべるコースを 選んでいる`,
    snuggle: `${item.name} で のんびり遊ぶ場所を 選んでいる`,
    reward: `${item.name} を どこへ投げるか 考えている`
  })[item.playStyle] || `${item.name} を どこで遊ぶか 選んでいる`;
}

function getToyChaseStatus(item) {
  return ({
    chase: `${item.name} を 見つけて はりきって 走りだした`,
    glide: `${item.name} を 目がけて つるっと すべりだした`,
    snuggle: `${item.name} に ゆっくり 近づいている`,
    reward: `${item.name} の ごほうびを 楽しみに 追いかけている`
  })[item.playStyle] || `${item.name} を 見つけて はりきって 走りだした`;
}

function getToyResultStatus(item) {
  return ({
    chase: `${item.name} で 元気いっぱい あそんだ`,
    glide: `${item.name} で 氷の上を すいすい すべった`,
    snuggle: `${item.name} と いっしょに まったり すごした`,
    reward: `${item.name} で あそんで ちいさな ごほうびも もらった`
  })[item.playStyle] || `${item.name} で 元気いっぱい あそんだ`;
}

function getToyFloatText(item) {
  return ({ chase: '+ごきげん', glide: '+エクササイズ', snuggle: '+なかよし', reward: '+ごほうび' })[item.playStyle] || '+ごきげん';
}

function getStageLabel() {
  const weightBand = getWeightBand();
  const stageLabels = [
    { light: 'あかちゃん', normal: 'あかちゃん', heavy: 'あかちゃん' },
    { light: 'すばしっこいこども', normal: 'こども', heavy: 'もちもちこども' },
    { light: 'しなやかおとな', normal: 'おとな', heavy: 'もっちりおとな' },
    { light: 'スリム名人', normal: 'ごきげん名人', heavy: 'もっちり名人' }
  ];
  return stageLabels[mainState.stage][weightBand];
}

function getWeightBand() {
  if (mainState.weight < 32) return 'light';
  if (mainState.weight > 52) return 'heavy';
  return 'normal';
}

function mapWeightToPercent(weight) {
  return ((weight - 16) / (80 - 16)) * 100;
}

function clampActionX(value, width) {
  return clamp(value, 240, width - 48);
}

function clampActionY(value, height) {
  return clamp(value, 34, height - 42);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function randomFrom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}
