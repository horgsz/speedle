export const WORD_LENGTH = 4;
export const MAX_GUESSES = 6;
export const INITIAL_TIME_MS = 30_000;
export const GUESS_TIME_BONUS_MS = 3_000;
export const DEFAULT_ANSWER_COUNT = 1_000;

/**
 * Row-by-row shifting hues for "correct" tiles:
 * Row 0 (Attempt 1, 6x) starts at glowing electric cyan-emerald and steps down
 * through neon emerald, bright green, classic green, sage, to muted moss on Row 5 (Attempt 6, 1x).
 */
export const ROW_HUES = [
  {
    row: 0,
    attempt: 1,
    multiplier: 6,
    color: "#00f5d4",
    border: "#33f7dd",
    glow: "rgba(0, 245, 212, 0.45)",
    textColor: "#04211f",
    name: "Electric Cyan-Mint",
    rank: "⚡ LIGHTNING",
  },
  {
    row: 1,
    attempt: 2,
    multiplier: 5,
    color: "#00e676",
    border: "#29eb8c",
    glow: "rgba(0, 230, 118, 0.36)",
    textColor: "#042212",
    name: "Neon Emerald",
    rank: "🔥 SUPERSONIC",
  },
  {
    row: 2,
    attempt: 3,
    multiplier: 4,
    color: "#1db954",
    border: "#34c768",
    glow: "rgba(29, 185, 84, 0.28)",
    textColor: "#ffffff",
    name: "Vibrant Green",
    rank: "🚀 TURBO",
  },
  {
    row: 3,
    attempt: 4,
    multiplier: 3,
    color: "#2e9e5b",
    border: "#41b06d",
    glow: "rgba(46, 158, 91, 0.22)",
    textColor: "#ffffff",
    name: "Classic Green",
    rank: "💨 SWIFT",
  },
  {
    row: 4,
    attempt: 5,
    multiplier: 2,
    color: "#4b8b5f",
    border: "#5e9c72",
    glow: "rgba(75, 139, 95, 0.16)",
    textColor: "#ffffff",
    name: "Sage Green",
    rank: "⏱️ CRUISING",
  },
  {
    row: 5,
    attempt: 6,
    multiplier: 1,
    color: "#647a61",
    border: "#788e75",
    glow: "rgba(100, 122, 97, 0.12)",
    textColor: "#ffffff",
    name: "Muted Moss",
    rank: "😅 BUZZER BEATER",
  },
];

/**
 * Pure Wordle duplicate-safe scoring for 4-letter words (used by build/test helpers).
 */
export function scoreGuessPlain(guess, answer) {
  if (typeof guess !== "string" || typeof answer !== "string") return null;
  const g = guess.trim().toLowerCase();
  const a = answer.trim().toLowerCase();
  if (!/^[a-z]{4}$/.test(g) || !/^[a-z]{4}$/.test(a)) return null;

  const result = Array(WORD_LENGTH).fill("absent");
  const remaining = {};

  for (let i = 0; i < WORD_LENGTH; i++) {
    if (g[i] === a[i]) {
      result[i] = "correct";
    } else {
      remaining[a[i]] = (remaining[a[i]] || 0) + 1;
    }
  }

  for (let i = 0; i < WORD_LENGTH; i++) {
    if (result[i] === "correct") continue;
    const ch = g[i];
    if (remaining[ch] > 0) {
      result[i] = "present";
      remaining[ch]--;
    }
  }

  return result;
}

export function getMultiplier(attemptNumber) {
  const clamped = Math.min(Math.max(1, Math.trunc(attemptNumber)), MAX_GUESSES);
  return 7 - clamped;
}

/**
 * Arcade multiplier scoring:
 * Score = (Guess Multiplier) * round(Seconds Remaining * 10)
 * Max possible score = 6 * 300 = 1800 pts.
 */
export function calculateScore(attemptNumber, remainingMs) {
  if (
    !Number.isFinite(attemptNumber) ||
    attemptNumber < 1 ||
    attemptNumber > MAX_GUESSES ||
    !Number.isFinite(remainingMs) ||
    remainingMs <= 0
  ) {
    return {
      score: 0,
      multiplier: 0,
      timeUnits: 0,
      secondsLeft: "0.0",
      tier: null,
    };
  }

  const multiplier = getMultiplier(attemptNumber);
  const clampedMs = Math.min(INITIAL_TIME_MS, Math.max(0, remainingMs));
  const timeUnits = Math.max(1, Math.round((clampedMs / 1000) * 10));
  const score = multiplier * timeUnits;
  const tier = ROW_HUES[attemptNumber - 1] || ROW_HUES[ROW_HUES.length - 1];

  return {
    score,
    multiplier,
    timeUnits,
    secondsLeft: (timeUnits / 10).toFixed(1),
    tier,
  };
}

/**
 * Adds +3.0s (3000ms) on a valid non-winning guess, capped at 30.0s (INITIAL_TIME_MS).
 */
export function applyTimeBonus(remainingMs, bonusMs = GUESS_TIME_BONUS_MS, maxMs = INITIAL_TIME_MS) {
  const before = Math.max(0, remainingMs);
  const after = Math.min(maxMs, before + bonusMs);
  return {
    remainingMs: after,
    addedMs: after - before,
  };
}

const EPOCH_DATE_STR = "2026-10-21"; // Day #1 launch date

export function getSydneyDateString(now = new Date()) {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Australia/Sydney",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(now);
    const y = parts.find((p) => p.type === "year").value;
    const m = parts.find((p) => p.type === "month").value;
    const d = parts.find((p) => p.type === "day").value;
    return `${y}-${m}-${d}`;
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

export function getDailyScheduleInfo(now = new Date(), totalAnswers = DEFAULT_ANSWER_COUNT) {
  const dateStr = typeof now === "string" ? now : getSydneyDateString(now);
  const [y, m, d] = dateStr.split("-").map(Number);
  const [ey, em, ed] = EPOCH_DATE_STR.split("-").map(Number);
  const utcDay = Date.UTC(y, m - 1, d);
  const utcEpoch = Date.UTC(ey, em - 1, ed);
  const diffDays = Math.floor((utcDay - utcEpoch) / 86_400_000);
  const dayNumber = Math.max(1, diffDays + 1);
  const capsuleIndex = ((diffDays % totalAnswers) + totalAnswers) % totalAnswers;

  return {
    id: `daily-${dateStr}`,
    dateStr,
    dayNumber,
    capsuleIndex,
  };
}

export function pickRandomCapsuleIndex(totalAnswers = DEFAULT_ANSWER_COUNT, excludeIndices = []) {
  const excluded = new Set(excludeIndices);
  const candidates = [];
  for (let i = 0; i < totalAnswers; i++) {
    if (!excluded.has(i)) candidates.push(i);
  }
  const pool = candidates.length > 0 ? candidates : Array.from({ length: totalAnswers }, (_, i) => i);
  return pool[Math.floor(Math.random() * pool.length)];
}
