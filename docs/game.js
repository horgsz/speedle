import {
  WORD_LENGTH,
  MAX_GUESSES,
  INITIAL_TIME_MS,
  GUESS_TIME_BONUS_MS,
  ROW_HUES,
  calculateScore,
  applyTimeBonus,
  getDailyScheduleInfo,
  pickRandomCapsuleIndex,
} from "./engine.js";
import { openVault, isSupported } from "./speedbox.js";

const DAILY_STATE_KEY = "speedle.dailyState.v2";
const DAILY_STATS_KEY = "speedle.dailyStats.v1";
const ARCADE_STATS_KEY = "speedle.arcadeStats.v1";
const HELP_SEEN_KEY = "speedle.helpSeen.v1";
const FLIP_MS = 115;

// ---- Persistence ----------------------------------------------------------

function load(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function save(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* ignore private browsing quota errors */
  }
}

function defaultStats() {
  return {
    played: 0,
    wins: 0,
    currentStreak: 0,
    maxStreak: 0,
    bestScore: 0,
    distribution: [0, 0, 0, 0, 0, 0],
    lastId: null,
  };
}

let dailyStats = load(DAILY_STATS_KEY, defaultStats());
let arcadeStats = load(ARCADE_STATS_KEY, defaultStats());

// ---- Game State -----------------------------------------------------------

let vault = null;
let mode = "daily"; // "daily" | "arcade"
let dailyInfo = getDailyScheduleInfo();
let activePuzzle = null;
let activeId = dailyInfo.id;
let revealedWord = null; // Only populated once a game ends
let recentArcadeIndices = [];

let state = {
  id: activeId,
  guesses: [],
  results: [],
  status: "playing", // "playing" | "won" | "lost" | "timeout"
  remainingMs: INITIAL_TIME_MS,
  finalScore: 0,
  winAttempt: null,
};

let currentInput = "";
let busy = true;
let timerRunning = false;
let timerPausedForAnim = false;
let lastFrameTime = 0;
let rafId = null;

// ---- DOM Elements ---------------------------------------------------------

const boardEl = document.getElementById("board");
const keyboardEl = document.getElementById("keyboard");
const toastEl = document.getElementById("toast");
const helpModal = document.getElementById("help-modal");
const statsModal = document.getElementById("stats-modal");
const copiedModal = document.getElementById("copied-modal");

const dayBadgeEl = document.getElementById("day-badge");
const modeDailyBtn = document.getElementById("mode-daily");
const modeArcadeBtn = document.getElementById("mode-arcade");
const mascotEl = document.getElementById("mascot");

const activeMultValEl = document.getElementById("active-mult-val");
const timerDisplayEl = document.getElementById("timer-display");
const timerDigitsEl = document.getElementById("timer-digits");
const timerBarEl = document.getElementById("timer-bar");
const timerHintEl = document.getElementById("timer-hint");
const timeBonusPopEl = document.getElementById("time-bonus-pop");
const hudRightLabelEl = document.getElementById("hud-right-label");
const hudScoreValEl = document.getElementById("hud-score-val");

const postGameBarEl = document.getElementById("post-game-bar");
const nextWordBtn = document.getElementById("next-word-btn");
const openResultsBtn = document.getElementById("open-results-btn");

const snakeBorderEl = document.getElementById("snake-border");
const snakeTrackEl = document.getElementById("snake-track");
const snakeBodyEl = document.getElementById("snake-body");
const snakeTipEl = document.getElementById("snake-tip");

function updateSnakeGeometry() {
  if (!snakeBorderEl) return;
  const rect = snakeBorderEl.getBoundingClientRect();
  const w = Math.max(280, Math.round(rect.width || window.innerWidth));
  const h = Math.max(360, Math.round(rect.height || window.innerHeight));
  const pad = 2;
  const r = 6;
  const cx = Math.round(w / 2);
  snakeBorderEl.setAttribute("viewBox", `0 0 ${w} ${h}`);
  const d = [
    `M ${cx} ${pad}`,
    `L ${w - pad - r} ${pad}`,
    `A ${r} ${r} 0 0 1 ${w - pad} ${pad + r}`,
    `L ${w - pad} ${h - pad - r}`,
    `A ${r} ${r} 0 0 1 ${w - pad - r} ${h - pad}`,
    `L ${pad + r} ${h - pad}`,
    `A ${r} ${r} 0 0 1 ${pad} ${h - pad - r}`,
    `L ${pad} ${pad + r}`,
    `A ${r} ${r} 0 0 1 ${pad + r} ${pad}`,
    `Z`,
  ].join(" ");
  snakeTrackEl.setAttribute("d", d);
  snakeBodyEl.setAttribute("d", d);
  snakeTipEl.setAttribute("d", d);
}

window.addEventListener("resize", updateSnakeGeometry);
if (window.visualViewport) {
  window.visualViewport.addEventListener("resize", updateSnakeGeometry);
}
updateSnakeGeometry();

const rows = [];
const keyEls = {};

for (let r = 0; r < MAX_GUESSES; r++) {
  const rowEl = document.createElement("div");
  rowEl.className = "row";
  rowEl.dataset.row = String(r);
  const hue = ROW_HUES[r];
  rowEl.style.setProperty("--row-color", hue.color);
  rowEl.style.setProperty("--row-text", hue.textColor);
  rowEl.style.setProperty("--row-glow", hue.glow);

  const multBadge = document.createElement("div");
  multBadge.className = "row-mult";
  multBadge.textContent = `${hue.multiplier}×`;
  multBadge.title = `Guess ${r + 1}: ${hue.multiplier}× score multiplier (${hue.name})`;
  rowEl.appendChild(multBadge);

  const tiles = [];
  for (let c = 0; c < WORD_LENGTH; c++) {
    const tile = document.createElement("div");
    tile.className = "tile";
    tile.style.setProperty("--i", String(c));
    rowEl.appendChild(tile);
    tiles.push(tile);
  }
  boardEl.appendChild(rowEl);
  rows.push({ el: rowEl, tiles, multBadge });
}

const KEY_ROWS = ["qwertyuiop", "asdfghjkl", ["enter", ..."zxcvbnm", "back"]];
KEY_ROWS.forEach((keys) => {
  const rowEl = document.createElement("div");
  rowEl.className = "kb-row";
  [...keys].forEach((k) => {
    const btn = document.createElement("button");
    btn.className = "key";
    btn.dataset.key = k;
    if (k === "enter") {
      btn.textContent = "Enter";
      btn.classList.add("wide");
    } else if (k === "back") {
      btn.textContent = "⌫";
      btn.classList.add("wide");
      btn.setAttribute("aria-label", "Backspace");
    } else {
      btn.textContent = k;
      keyEls[k] = btn;
    }
    btn.addEventListener("click", (e) => {
      e.currentTarget.blur();
      handleKey(k);
    });
    rowEl.appendChild(btn);
  });
  keyboardEl.appendChild(rowEl);
});

// ---- UI & Toast Helpers ---------------------------------------------------

let toastTimer = null;
function toast(msg, ms = 1600) {
  toastEl.textContent = msg;
  toastEl.classList.add("show");
  clearTimeout(toastTimer);
  if (ms > 0) {
    toastTimer = setTimeout(() => toastEl.classList.remove("show"), ms);
  }
}

let moodTimer = null;
function setMood(mood, ms = 1300) {
  mascotEl.dataset.mood = mood;
  clearTimeout(moodTimer);
  if (ms > 0) {
    moodTimer = setTimeout(() => {
      mascotEl.dataset.mood = "idle";
    }, ms);
  }
}

function shakeCurrentRow() {
  const r = Math.min(state.guesses.length, MAX_GUESSES - 1);
  const rowEl = rows[r].el;
  rowEl.classList.remove("shake");
  void rowEl.offsetWidth;
  rowEl.classList.add("shake");
}

let snakeGrowTimer = null;
function showBonusPop(addedMs) {
  if (addedMs <= 0) return;
  const secs = (addedMs / 1000).toFixed(1);
  timeBonusPopEl.textContent = `+${secs}s`;
  timeBonusPopEl.classList.remove("hidden");
  timeBonusPopEl.style.animation = "none";
  void timeBonusPopEl.offsetWidth;
  timeBonusPopEl.style.animation = "";
  setTimeout(() => {
    timeBonusPopEl.classList.add("hidden");
  }, 950);

  if (snakeBorderEl) {
    snakeBorderEl.classList.add("snake-grow");
    clearTimeout(snakeGrowTimer);
    snakeGrowTimer = setTimeout(() => {
      snakeBorderEl.classList.remove("snake-grow");
    }, 520);
  }
}

// ---- Timer Engine ---------------------------------------------------------

function updateHudDisplay() {
  const sec = Math.max(0, state.remainingMs / 1000);
  timerDigitsEl.textContent = `${sec.toFixed(1)}s`;

  const ratio = Math.max(0, Math.min(1, state.remainingMs / INITIAL_TIME_MS));
  timerBarEl.style.transform = `scaleX(${ratio})`;

  if (snakeBodyEl && snakeTipEl && snakeBorderEl) {
    const snakeLen = ratio * 1000;
    snakeBodyEl.style.strokeDasharray = `${snakeLen.toFixed(1)} 1000`;
    snakeTipEl.style.strokeDashoffset = `${(-Math.max(0, snakeLen - 2)).toFixed(1)}`;
  }

  timerBarEl.classList.remove("warn", "danger");
  let visualState = "ready";
  if (ratio <= 0) {
    visualState = "empty";
    timerDisplayEl.dataset.state = "danger";
  } else if (state.status !== "playing") {
    visualState = state.status === "won" ? "running" : "danger";
    timerDisplayEl.dataset.state = visualState;
  } else if (!timerRunning) {
    visualState = "ready";
    timerDisplayEl.dataset.state = "ready";
  } else if (sec <= 6) {
    visualState = "danger";
    timerDisplayEl.dataset.state = "danger";
    timerBarEl.classList.add("danger");
  } else if (sec <= 14) {
    visualState = "warn";
    timerDisplayEl.dataset.state = "warn";
    timerBarEl.classList.add("warn");
  } else {
    visualState = "running";
    timerDisplayEl.dataset.state = "running";
  }
  if (snakeBorderEl) {
    snakeBorderEl.dataset.state = visualState;
  }

  const currentAttempt = Math.min(state.guesses.length + 1, MAX_GUESSES);
  const hue = ROW_HUES[currentAttempt - 1];

  if (state.status === "playing") {
    activeMultValEl.textContent = `${hue.multiplier}×`;
    activeMultValEl.style.color = hue.color;
    hudRightLabelEl.textContent = "POTENTIAL";
    const potential = calculateScore(currentAttempt, state.remainingMs).score;
    hudScoreValEl.textContent = String(potential);
  } else {
    const winHue = state.winAttempt ? ROW_HUES[state.winAttempt - 1] : ROW_HUES[5];
    activeMultValEl.textContent = state.winAttempt ? `${winHue.multiplier}×` : "0×";
    activeMultValEl.style.color = state.winAttempt ? winHue.color : "var(--text-muted)";
    hudRightLabelEl.textContent = "FINAL SCORE";
    hudScoreValEl.textContent = String(state.finalScore || 0);
  }

  rows.forEach((rObj, idx) => {
    rObj.el.classList.toggle("active-row", state.status === "playing" && idx === state.guesses.length);
    rObj.el.classList.toggle("past-row", idx < state.guesses.length && !rObj.el.classList.contains("win"));
  });
}

function tickTimer(now) {
  if (!timerRunning || state.status !== "playing") return;
  if (!timerPausedForAnim) {
    const dt = Math.max(0, now - lastFrameTime);
    state.remainingMs = Math.max(0, state.remainingMs - dt);
    updateHudDisplay();
    if (state.remainingMs <= 0) {
      handleTimeout();
      return;
    }
  }
  lastFrameTime = now;
  rafId = requestAnimationFrame(tickTimer);
}

function startTimerIfNeeded() {
  if (timerRunning || state.status !== "playing") return;
  timerRunning = true;
  timerPausedForAnim = false;
  lastFrameTime = performance.now();
  timerHintEl.textContent = "⚡ Clock running! Each valid guess adds +3.0s";
  updateHudDisplay();
  rafId = requestAnimationFrame(tickTimer);
}

function stopTimer() {
  timerRunning = false;
  timerPausedForAnim = false;
  if (rafId) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
}

// ---- Painting Board & Keyboard --------------------------------------------

const STATUS_RANK = { absent: 1, present: 2, correct: 3 };

function colourKey(letter, status, rowIdx) {
  const el = keyEls[letter];
  if (!el) return;
  const prevStatus = el.dataset.status;
  const prevRow = el.dataset.bestRow ? Number(el.dataset.bestRow) : 99;

  if (!prevStatus || STATUS_RANK[status] > STATUS_RANK[prevStatus]) {
    el.dataset.status = status;
    el.classList.remove("absent", "present", "correct");
    el.classList.add(status);
  }

  if (status === "correct" && rowIdx < prevRow) {
    el.dataset.bestRow = String(rowIdx);
    const hue = ROW_HUES[rowIdx];
    el.style.setProperty("--key-correct-bg", hue.color);
    el.style.setProperty("--key-correct-text", hue.textColor);
    el.style.setProperty("--key-correct-glow", hue.glow);
  }
}

function paintRow(r, guess, result, animate) {
  const { tiles } = rows[r];
  return new Promise((resolve) => {
    result.forEach((status, i) => {
      const tile = tiles[i];
      tile.textContent = guess[i];
      const apply = () => {
        tile.classList.remove("filled");
        tile.classList.add(status);
        colourKey(guess[i], status, r);
      };
      if (animate) {
        setTimeout(() => {
          tile.classList.add("reveal");
          setTimeout(apply, FLIP_MS);
        }, i * FLIP_MS);
      } else {
        apply();
      }
    });
    setTimeout(resolve, animate ? WORD_LENGTH * FLIP_MS + FLIP_MS : 0);
  });
}

function renderCurrentInput() {
  const r = state.guesses.length;
  if (r >= MAX_GUESSES || state.status !== "playing") return;
  rows[r].tiles.forEach((tile, i) => {
    const ch = currentInput[i] || "";
    tile.textContent = ch;
    tile.classList.toggle("filled", !!ch);
  });
}

function clearBoardDOM() {
  rows.forEach(({ el, tiles }) => {
    el.classList.remove("win", "shake", "active-row", "past-row");
    tiles.forEach((tile) => {
      tile.textContent = "";
      tile.className = "tile";
    });
  });
  Object.values(keyEls).forEach((btn) => {
    btn.className = "key";
    delete btn.dataset.status;
    delete btn.dataset.bestRow;
    btn.style.removeProperty("--key-correct-bg");
    btn.style.removeProperty("--key-correct-text");
    btn.style.removeProperty("--key-correct-glow");
  });
}

// ---- Gameplay Flow --------------------------------------------------------

function saveCurrentState() {
  if (mode === "daily") {
    save(DAILY_STATE_KEY, state);
  }
}

function recordStats(won, attempt, score) {
  const targetStats = mode === "daily" ? dailyStats : arcadeStats;
  const storageKey = mode === "daily" ? DAILY_STATS_KEY : ARCADE_STATS_KEY;

  if (mode === "daily" && targetStats.lastId === state.id) return;
  targetStats.lastId = state.id;
  targetStats.played += 1;

  if (won) {
    targetStats.wins += 1;
    targetStats.currentStreak += 1;
    targetStats.maxStreak = Math.max(targetStats.maxStreak, targetStats.currentStreak);
    targetStats.bestScore = Math.max(targetStats.bestScore || 0, score);
    if (attempt >= 1 && attempt <= MAX_GUESSES) {
      targetStats.distribution[attempt - 1] += 1;
    }
  } else {
    targetStats.currentStreak = 0;
  }

  save(storageKey, targetStats);
}

async function handleTimeout() {
  stopTimer();
  busy = true;
  state.remainingMs = 0;
  state.status = "timeout";
  state.finalScore = 0;
  currentInput = "";
  renderCurrentInput();
  shakeCurrentRow();
  setMood("sad", 0);
  updateHudDisplay();
  saveCurrentState();
  recordStats(false, null, 0);

  revealedWord = await activePuzzle.reveal();
  timerHintEl.textContent = `⏰ Time's up! The word was ${revealedWord.toUpperCase()}`;
  toast(`⏰ TIME'S UP! It was ${revealedWord.toUpperCase()}`, 3200);
  postGameBarEl.classList.remove("hidden");
  busy = false;
  setTimeout(() => openStatsModal(), 750);
}

async function submitGuess() {
  if (busy || state.status !== "playing") return;
  if (currentInput.length < WORD_LENGTH) {
    toast("Need 4 letters!");
    shakeCurrentRow();
    setMood("oops");
    return;
  }

  // Pause clock while hashing and revealing so crypto/animation time is free
  busy = true;
  timerPausedForAnim = true;

  const guess = currentInput.toLowerCase();
  const result = await activePuzzle.score(guess);
  if (!result) {
    timerPausedForAnim = false;
    lastFrameTime = performance.now();
    busy = false;
    toast("Not in word list");
    shakeCurrentRow();
    setMood("oops");
    return;
  }

  const r = state.guesses.length;
  const attemptNum = r + 1;
  state.guesses.push(guess);
  state.results.push(result);
  currentInput = "";
  saveCurrentState();

  await paintRow(r, guess, result, true);

  if (state.status !== "playing") {
    busy = false;
    return;
  }

  const won = result.every((s) => s === "correct");

  if (won) {
    stopTimer();
    const scoreInfo = calculateScore(attemptNum, state.remainingMs);
    state.status = "won";
    state.winAttempt = attemptNum;
    state.finalScore = scoreInfo.score;
    revealedWord = guess;
    rows[r].el.classList.add("win");
    setMood("cheer", 0);
    timerHintEl.textContent = `${scoreInfo.tier.rank} — ${scoreInfo.multiplier}× × ${scoreInfo.secondsLeft}s = ${scoreInfo.score} PTS!`;
    updateHudDisplay();
    saveCurrentState();
    recordStats(true, attemptNum, scoreInfo.score);
    toast(`${scoreInfo.tier.rank}! +${scoreInfo.score} PTS`, 2600);
    postGameBarEl.classList.remove("hidden");
    busy = false;
    setTimeout(() => openStatsModal(), 650);
  } else if (state.guesses.length >= MAX_GUESSES) {
    stopTimer();
    state.status = "lost";
    state.finalScore = 0;
    setMood("sad", 0);
    updateHudDisplay();
    saveCurrentState();
    recordStats(false, null, 0);

    revealedWord = await activePuzzle.reveal();
    timerHintEl.textContent = `Out of guesses! The word was ${revealedWord.toUpperCase()}`;
    toast(`Out of tries! It was ${revealedWord.toUpperCase()}`, 3200);
    postGameBarEl.classList.remove("hidden");
    busy = false;
    setTimeout(() => openStatsModal(), 750);
  } else {
    const bonus = applyTimeBonus(state.remainingMs, GUESS_TIME_BONUS_MS, INITIAL_TIME_MS);
    state.remainingMs = bonus.remainingMs;
    showBonusPop(bonus.addedMs);
    setMood("happy", 900);
    saveCurrentState();

    timerPausedForAnim = false;
    lastFrameTime = performance.now();
    updateHudDisplay();
    busy = false;
  }
}

function handleKey(key) {
  if (busy) return;

  if (state.status !== "playing") {
    if (key === "enter" && statsModal.classList.contains("hidden")) {
      startArcadeRound();
    }
    return;
  }

  if (key === "enter") {
    submitGuess();
  } else if (key === "back") {
    if (currentInput.length > 0) {
      currentInput = currentInput.slice(0, -1);
      renderCurrentInput();
    }
  } else if (/^[a-z]$/.test(key)) {
    if (currentInput.length < WORD_LENGTH) {
      startTimerIfNeeded();
      currentInput += key;
      renderCurrentInput();
    }
  }
}

document.addEventListener("keydown", (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === "Escape") {
    [helpModal, statsModal, copiedModal].forEach((m) => m.classList.add("hidden"));
    return;
  }
  if (!helpModal.classList.contains("hidden") || !copiedModal.classList.contains("hidden")) {
    return;
  }
  if (!statsModal.classList.contains("hidden")) {
    if (e.key === "Enter") {
      statsModal.classList.add("hidden");
      startArcadeRound();
    }
    return;
  }
  const k = e.key.toLowerCase();
  if (k === "enter") {
    e.preventDefault();
    handleKey("enter");
  } else if (k === "backspace") {
    handleKey("back");
  } else if (/^[a-z]$/.test(k)) {
    handleKey(k);
  }
});

// ---- Mode Switching & Round Setup -----------------------------------------

async function loadDailyMode() {
  if (!vault) return;
  stopTimer();
  busy = true;
  mode = "daily";
  modeDailyBtn.classList.add("active");
  modeDailyBtn.setAttribute("aria-selected", "true");
  modeArcadeBtn.classList.remove("active");
  modeArcadeBtn.setAttribute("aria-selected", "false");

  dailyInfo = getDailyScheduleInfo(new Date(), vault.answerCount);
  activePuzzle = vault.getPuzzle(dailyInfo.capsuleIndex);
  activeId = dailyInfo.id;
  revealedWord = null;
  dayBadgeEl.textContent = `#${dailyInfo.dayNumber}`;

  clearBoardDOM();
  currentInput = "";

  const saved = load(DAILY_STATE_KEY, null);
  if (saved && saved.id === activeId && Array.isArray(saved.guesses)) {
    state = {
      ...saved,
      results: Array.isArray(saved.results) ? saved.results : [],
    };
    for (let r = 0; r < state.guesses.length; r++) {
      const g = state.guesses[r];
      const res = state.results[r] || (await activePuzzle.score(g));
      state.results[r] = res;
      if (res) await paintRow(r, g, res, false);
    }
    if (state.status === "won" && state.winAttempt) {
      revealedWord = state.guesses[state.winAttempt - 1];
      rows[state.winAttempt - 1].el.classList.add("win");
      const scoreInfo = calculateScore(state.winAttempt, state.remainingMs);
      timerHintEl.textContent = `${scoreInfo.tier.rank} — ${scoreInfo.multiplier}× × ${scoreInfo.secondsLeft}s = ${state.finalScore} PTS!`;
      postGameBarEl.classList.remove("hidden");
    } else if (state.status === "lost" || state.status === "timeout") {
      revealedWord = await activePuzzle.reveal();
      timerHintEl.textContent = `The daily word was ${revealedWord.toUpperCase()}`;
      postGameBarEl.classList.remove("hidden");
    } else {
      timerHintEl.textContent =
        state.guesses.length > 0
          ? "Type a letter to resume your 30s clock!"
          : "Type your first letter to start the 30s clock! (+3s per guess)";
      postGameBarEl.classList.add("hidden");
    }
  } else {
    state = {
      id: activeId,
      guesses: [],
      results: [],
      status: "playing",
      remainingMs: INITIAL_TIME_MS,
      finalScore: 0,
      winAttempt: null,
    };
    timerHintEl.textContent = "Type your first letter to start the 30s clock! (+3s per guess)";
    postGameBarEl.classList.add("hidden");
  }

  updateHudDisplay();
  busy = false;
}

function startArcadeRound() {
  if (!vault) return;
  stopTimer();
  mode = "arcade";
  modeArcadeBtn.classList.add("active");
  modeArcadeBtn.setAttribute("aria-selected", "true");
  modeDailyBtn.classList.remove("active");
  modeDailyBtn.setAttribute("aria-selected", "false");

  const nextIdx = pickRandomCapsuleIndex(vault.answerCount, [
    dailyInfo.capsuleIndex,
    ...recentArcadeIndices,
  ]);
  recentArcadeIndices.push(nextIdx);
  if (recentArcadeIndices.length > 50) recentArcadeIndices.shift();

  activePuzzle = vault.getPuzzle(nextIdx);
  activeId = `arcade-${Date.now()}`;
  revealedWord = null;
  dayBadgeEl.textContent = "ARCADE";

  clearBoardDOM();
  currentInput = "";
  state = {
    id: activeId,
    guesses: [],
    results: [],
    status: "playing",
    remainingMs: INITIAL_TIME_MS,
    finalScore: 0,
    winAttempt: null,
  };

  postGameBarEl.classList.add("hidden");
  statsModal.classList.add("hidden");
  timerHintEl.textContent = "Arcade Round! Type your first letter to start the 30s clock!";
  setMood("idle", 0);
  updateHudDisplay();
  busy = false;
}

modeDailyBtn.addEventListener("click", () => {
  if (mode !== "daily") loadDailyMode();
});

modeArcadeBtn.addEventListener("click", () => {
  if (mode !== "arcade") startArcadeRound();
});

nextWordBtn.addEventListener("click", () => {
  startArcadeRound();
});

openResultsBtn.addEventListener("click", () => {
  openStatsModal();
});

// ---- Stats, Share & Modals ------------------------------------------------

function buildShareText() {
  const headerTag = mode === "daily" ? `Speedle #${dailyInfo.dayNumber}` : "Speedle ⚡ Arcade";
  const tries = state.status === "won" ? `${state.guesses.length}/${MAX_GUESSES}` : `X/${MAX_GUESSES}`;
  const secLeft = (Math.max(0, state.remainingMs) / 1000).toFixed(1);
  const hue = state.winAttempt ? ROW_HUES[state.winAttempt - 1] : null;
  const rankStr =
    state.status === "won" && hue
      ? `${hue.rank} (${hue.multiplier}×)`
      : state.status === "timeout"
        ? "⏰ TIME'S UP"
        : "💥 OUT OF TRIES";

  const grid = state.results
    .map((res) =>
      (res || [])
        .map((s) => (s === "correct" ? "🟩" : s === "present" ? "🟨" : "⬛"))
        .join("")
    )
    .join("\n");

  return [
    `⚡ ${headerTag} — ${tries}`,
    `${rankStr} • ⏱ ${secLeft}s left • 🏆 ${state.finalScore} PTS`,
    "",
    grid,
  ].join("\n");
}

function openStatsModal() {
  const s = mode === "daily" ? dailyStats : arcadeStats;
  document.getElementById("stats-title").textContent =
    mode === "daily" ? "Daily Speedle Stats" : "⚡ Arcade Telemetry";
  document.getElementById("day-label").textContent =
    mode === "daily" ? `Daily Speedle #${dailyInfo.dayNumber}` : "Unlimited Arcade Mode";

  const scoreCardEl = document.getElementById("score-card");
  const shareBtn = document.getElementById("share-btn");
  const sendBtn = document.getElementById("send-btn");
  const modalNextBtn = document.getElementById("modal-next-btn");

  if (state.status !== "playing") {
    scoreCardEl.classList.remove("hidden");
    const rankBadgeEl = document.getElementById("rank-badge");
    const finalScoreEl = document.getElementById("final-score");
    const formulaEl = document.getElementById("score-formula");
    const answerRevealEl = document.getElementById("answer-reveal");

    if (state.status === "won" && state.winAttempt) {
      const info = calculateScore(state.winAttempt, state.remainingMs);
      scoreCardEl.style.setProperty("--score-border", info.tier.color);
      scoreCardEl.style.setProperty("--score-glow", info.tier.glow);
      scoreCardEl.style.setProperty("--score-text", info.tier.textColor);
      rankBadgeEl.textContent = `${info.tier.rank} • ${info.tier.name.toUpperCase()}`;
      finalScoreEl.textContent = `${state.finalScore} PTS`;
      formulaEl.textContent = `${info.multiplier}× (Guess #${state.winAttempt}) × ${info.secondsLeft}s left`;
    } else {
      scoreCardEl.style.setProperty("--score-border", "var(--danger)");
      scoreCardEl.style.setProperty("--score-glow", "rgba(239, 68, 68, 0.2)");
      scoreCardEl.style.setProperty("--score-text", "#ffffff");
      rankBadgeEl.textContent = state.status === "timeout" ? "⏰ TIME'S UP (0.0s)" : "💥 OUT OF GUESSES";
      finalScoreEl.textContent = "0 PTS";
      formulaEl.textContent = "Solve within 30 seconds to score!";
    }
    const wordStr = revealedWord ? revealedWord.toUpperCase() : "••••";
    answerRevealEl.innerHTML = `WORD: <strong>${wordStr}</strong>`;

    shareBtn.classList.remove("hidden");
    sendBtn.classList.toggle("hidden", typeof navigator.share !== "function");
    modalNextBtn.classList.remove("hidden");
    modalNextBtn.textContent = mode === "daily" ? "⚡ Play Unlimited Arcade" : "⚡ Next Word (Enter)";
  } else {
    scoreCardEl.classList.add("hidden");
    shareBtn.classList.add("hidden");
    sendBtn.classList.add("hidden");
    modalNextBtn.classList.add("hidden");
  }

  document.getElementById("stat-played").textContent = String(s.played);
  document.getElementById("stat-win").textContent = s.played ? String(Math.round((100 * s.wins) / s.played)) : "0";
  document.getElementById("stat-streak").textContent = String(s.currentStreak);
  document.getElementById("stat-best").textContent = String(s.bestScore || 0);

  const distEl = document.getElementById("distribution");
  distEl.innerHTML = "";
  const maxCount = Math.max(1, ...s.distribution);
  s.distribution.forEach((count, i) => {
    const hue = ROW_HUES[i];
    const row = document.createElement("div");
    row.className = "dist-row";
    const bar = document.createElement("div");
    bar.className = "dist-bar";
    bar.style.width = `${Math.max(8, Math.round((100 * count) / maxCount))}%`;
    if (count > 0 || (state.status === "won" && state.winAttempt === i + 1)) {
      bar.style.background = hue.color;
      bar.style.color = hue.textColor;
    }
    bar.textContent = String(count);
    row.innerHTML = `<span class="dist-label">${i + 1} (${hue.multiplier}×)</span>`;
    row.appendChild(bar);
    distEl.appendChild(row);
  });

  statsModal.classList.remove("hidden");
}

async function copyText(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      /* fallback below */
    }
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.cssText = "position:fixed;top:0;left:0;opacity:0;";
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

function showCopiedModal(text, ok) {
  document.getElementById("copied-title").textContent = ok ? "Copied! ⚡" : "Copy your score";
  document.getElementById("copied-sub").textContent = ok
    ? "Your Speedle result is on the clipboard. Paste it into the group chat!"
    : "Press and hold the text below to copy:";
  const preview = document.getElementById("copied-preview");
  preview.value = text;
  copiedModal.classList.remove("hidden");
}

document.getElementById("share-btn").addEventListener("click", async () => {
  const text = buildShareText();
  const ok = await copyText(text);
  showCopiedModal(text, ok);
});

document.getElementById("send-btn").addEventListener("click", async () => {
  const text = buildShareText();
  try {
    await navigator.share({ text });
  } catch (e) {
    if (e && e.name === "AbortError") return;
    const ok = await copyText(text);
    showCopiedModal(text, ok);
  }
});

document.getElementById("modal-next-btn").addEventListener("click", () => {
  startArcadeRound();
});

document.getElementById("help-btn").addEventListener("click", () => {
  helpModal.classList.remove("hidden");
});

document.getElementById("stats-btn").addEventListener("click", () => {
  openStatsModal();
});

mascotEl.addEventListener("click", () => {
  setMood("cheer", 900);
});

document.querySelectorAll("[data-close]").forEach((btn) => {
  btn.addEventListener("click", () => {
    btn.closest(".modal").classList.add("hidden");
  });
});

[helpModal, statsModal, copiedModal].forEach((modal) => {
  modal.addEventListener("click", (e) => {
    if (e.target === modal) modal.classList.add("hidden");
  });
});

// ---- Startup & Vault Loading ----------------------------------------------

async function fetchVault() {
  const metaRes = await fetch("vault.json", { cache: "no-store" });
  if (!metaRes.ok) throw new Error(`HTTP ${metaRes.status}`);
  const meta = await metaRes.json();

  const binRes = await fetch(`vault.bin?${meta.h}`, { cache: "no-store" });
  if (!binRes.ok) throw new Error(`HTTP ${binRes.status}`);
  const bin = new Uint8Array(await binRes.arrayBuffer());

  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bin));
  const hex = Array.from(digest.subarray(0, 8), (b) => b.toString(16).padStart(2, "0")).join("");
  if (hex !== meta.h) throw new Error("Vault integrity mismatch");

  return openVault(meta, bin);
}

async function start() {
  if (!isSupported()) {
    toast("Speedle needs to be served over http(s)", 0);
    return;
  }
  try {
    vault = await fetchVault();
  } catch {
    toast("Couldn't load Speedle vault. Try refreshing.", 0);
    return;
  }

  await loadDailyMode();

  if (!localStorage.getItem(HELP_SEEN_KEY) && state.status === "playing" && state.guesses.length === 0) {
    helpModal.classList.remove("hidden");
    try {
      localStorage.setItem(HELP_SEEN_KEY, "1");
    } catch {
      /* ignore */
    }
  }
}

start();
