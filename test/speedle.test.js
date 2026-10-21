import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { COMMON_WORDS, VALID_GUESSES } from "../docs/words.js";
import {
  WORD_LENGTH,
  MAX_GUESSES,
  INITIAL_TIME_MS,
  GUESS_TIME_BONUS_MS,
  ROW_HUES,
  scoreGuessPlain,
  calculateScore,
  applyTimeBonus,
  getDailyScheduleInfo,
} from "../docs/engine.js";
import { sealVault, openVault } from "../docs/speedbox.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const site = join(root, "_site");

test("COMMON_WORDS contains exactly 1,000 unique 4-letter lowercase words", () => {
  assert.equal(COMMON_WORDS.length, 1000);
  const unique = new Set(COMMON_WORDS);
  assert.equal(unique.size, 1000);
  for (const w of COMMON_WORDS) {
    assert.match(w, /^[a-z]{4}$/, `Invalid word in COMMON_WORDS: ${w}`);
    assert.ok(VALID_GUESSES.has(w), `${w} must be in VALID_GUESSES`);
  }
});

test("speedbox sealVault and openVault score guesses and reveal without leaking plaintext", async () => {
  const sampleAnswers = ["fast", "ball", "stop"];
  const sampleGuesses = new Set(["fast", "ball", "stop", "pots", "bell", "lull", "time"]);
  const { meta, bin } = await sealVault(sampleAnswers, sampleGuesses, {
    guessIterations: 50,
    tagIterations: 50,
    revealIterations: 100,
  });

  const vault = openVault(meta, bin);
  assert.equal(vault.answerCount, 3);

  const p0 = vault.getPuzzle(0); // "fast"
  assert.equal(await p0.score("zzzz"), null);
  assert.deepEqual(await p0.score("fast"), ["correct", "correct", "correct", "correct"]);
  assert.equal(await p0.reveal(), "fast");

  const p1 = vault.getPuzzle(1); // "ball"
  assert.deepEqual(await p1.score("bell"), ["correct", "absent", "correct", "correct"]);
  assert.deepEqual(await p1.score("lull"), ["absent", "absent", "correct", "correct"]);
  assert.equal(await p1.reveal(), "ball");

  const p2 = vault.getPuzzle(2); // "stop"
  assert.deepEqual(await p2.score("pots"), ["present", "present", "present", "present"]);
  assert.equal(await p2.reveal(), "stop");
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
  const max = calculateScore(1, 30_000);
  assert.equal(max.score, 1800);
  assert.equal(max.multiplier, 6);

  const mid = calculateScore(3, 18_400);
  assert.equal(mid.score, 736);
  assert.equal(mid.multiplier, 4);
  assert.equal(mid.secondsLeft, "18.4");

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

test("getDailyScheduleInfo visits all 1,000 capsule indices over 1,000 days without repeats", () => {
  const seen = new Set();
  const start = Date.UTC(2026, 9, 21);
  for (let d = 0; d < 1000; d++) {
    const dt = new Date(start + d * 86_400_000).toISOString().slice(0, 10);
    const info = getDailyScheduleInfo(dt, 1000);
    seen.add(info.capsuleIndex);
  }
  assert.equal(seen.size, 1000);
});

test("the built site publishes only minified app.js and vault files, never words.js or plain word lists", async () => {
  execFileSync(process.execPath, [join(root, "scripts/build-site.mjs")], {
    cwd: root,
    env: {
      ...process.env,
      SPEEDLE_SEED: "build-test-seed-speedle",
    },
    stdio: "pipe",
  });

  assert.deepEqual(
    (await readdir(site)).sort(),
    ["app.js", "index.html", "style.css", "vault.bin", "vault.json"]
  );

  const app = await readFile(join(site, "app.js"), "utf8");
  assert.ok(!app.includes("COMMON_WORDS") && !app.includes("VALID_GUESSES") && !app.includes("EXTRA_GUESSES"));
  assert.ok(!app.includes("aals aams") && !app.includes("able acid acre"));
  assert.ok(!app.includes("// ----"), "bundle is minified");
  assert.match(await readFile(join(site, "index.html"), "utf8"), /src="app\.js"/);

  const meta = JSON.parse(await readFile(join(site, "vault.json"), "utf8"));
  const bin = new Uint8Array(await readFile(join(site, "vault.bin")));
  const v = openVault(meta, bin);
  assert.equal(v.answerCount, 1000);
  const p = v.getPuzzle(0);
  const w = await p.reveal();
  assert.deepEqual(await p.score(w), Array(WORD_LENGTH).fill("correct"));
});
