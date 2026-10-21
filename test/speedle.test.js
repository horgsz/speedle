import { test } from "node:test";
import assert from "node:assert/strict";
import { COMMON_WORDS, VALID_GUESSES } from "../docs/words.js";
import {
  WORD_LENGTH,
  MAX_GUESSES,
  INITIAL_TIME_MS,
  GUESS_TIME_BONUS_MS,
  ROW_HUES,
  isValidGuess,
  scoreGuess,
  calculateScore,
  applyTimeBonus,
  getDailyPuzzle,
} from "../docs/engine.js";

test("COMMON_WORDS contains exactly 1,000 unique 4-letter lowercase words", () => {
  assert.equal(COMMON_WORDS.length, 1000);
  const unique = new Set(COMMON_WORDS);
  assert.equal(unique.size, 1000);
  for (const w of COMMON_WORDS) {
    assert.match(w, /^[a-z]{4}$/, `Invalid word in COMMON_WORDS: ${w}`);
    assert.ok(VALID_GUESSES.has(w), `${w} must be in VALID_GUESSES`);
  }
});

test("scoreGuess scores exact, present, absent, and duplicate letters properly", () => {
  assert.equal(scoreGuess("zzzz", "fast"), null);
  assert.equal(scoreGuess("too", "fast"), null);
  assert.deepEqual(scoreGuess("fast", "fast"), ["correct", "correct", "correct", "correct"]);
  assert.deepEqual(scoreGuess("tsaf", "fast"), ["present", "present", "present", "present"]);
  assert.deepEqual(scoreGuess("bell", "ball"), ["correct", "absent", "correct", "correct"]);
  assert.deepEqual(scoreGuess("lull", "ball"), ["absent", "absent", "correct", "correct"]);
});

test("ROW_HUES defines 6 distinct green/teal hues with multipliers 6x down to 1x", () => {
  assert.equal(ROW_HUES.length, MAX_GUESSES);
  const colors = new Set(ROW_HUES.map((h) => h.color));
  assert.equal(colors.size, 6);
  assert.deepEqual(
    ROW_HUES.map((h) => h.multiplier),
    [6, 5, 4, 3, 2, 1]
  );
});

test("calculateScore computes (7 - attempt) * round(secondsLeft * 10)", () => {
  // 1st guess (6x) with 30.0s left = 6 * 300 = 1800
  const max = calculateScore(1, 30_000);
  assert.equal(max.score, 1800);
  assert.equal(max.multiplier, 6);

  // 3rd guess (4x) with 18.4s left = 4 * 184 = 736
  const mid = calculateScore(3, 18_400);
  assert.equal(mid.score, 736);
  assert.equal(mid.multiplier, 4);
  assert.equal(mid.secondsLeft, "18.4");

  // Timeout = 0
  assert.equal(calculateScore(2, 0).score, 0);
});

test("applyTimeBonus adds +3.0s per valid guess and caps at 30.0s", () => {
  const res1 = applyTimeBonus(15_000);
  assert.equal(res1.remainingMs, 18_000);
  assert.equal(res1.addedMs, GUESS_TIME_BONUS_MS);

  const res2 = applyTimeBonus(28_500);
  assert.equal(res2.remainingMs, INITIAL_TIME_MS);
  assert.equal(res2.addedMs, 1_500);
});

test("getDailyPuzzle visits all 1,000 common words over 1,000 days without repeats", () => {
  const seen = new Set();
  const start = Date.UTC(2026, 9, 21);
  for (let d = 0; d < 1000; d++) {
    const dt = new Date(start + d * 86_400_000).toISOString().slice(0, 10);
    const p = getDailyPuzzle(dt);
    assert.equal(p.answer.length, WORD_LENGTH);
    seen.add(p.answer);
  }
  assert.equal(seen.size, 1000);
});
