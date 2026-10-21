#!/usr/bin/env node
// Build the GitHub Pages site into _site/ with obfuscated vault.bin + vault.json and minified app.js.
// The readable source files and plain word lists (words.js) are never published.

import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { build } from "esbuild";
import { sealVault, openVault } from "../docs/speedbox.js";
import { COMMON_WORDS, VALID_GUESSES } from "../docs/words.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const docs = join(root, "docs");
const out = join(root, "_site");

function fail(msg) {
  console.error(`✖ ${msg}`);
  process.exit(1);
}

/** Deterministic shuffle of the 1,000 common words keyed by SPEEDLE_SEED. */
function buildScheduledWords(words, seedStr) {
  const list = [...words];
  const hash = createHash("sha256").update(`speedle-schedule:${seedStr}`).digest();
  let state = hash.readUInt32LE(0) || 0x5eed1e42;
  const nextRand = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x100000000;
  };
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(nextRand() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

const seed = process.env.SPEEDLE_SEED || "speedle-default-v1-seed";
const orderedAnswers = buildScheduledWords(COMMON_WORDS, seed);

const { meta, bin } = await sealVault(orderedAnswers, VALID_GUESSES);

// Self-check the sealed vault before writing
const opened = openVault(meta, bin);
const p0 = opened.getPuzzle(0);
const firstWord = orderedAnswers[0];
const checkScore = await p0.score(firstWord);
const checkReveal = await p0.reveal();
if (!checkScore || !checkScore.every((s) => s === "correct") || checkReveal !== firstWord) {
  fail("Vault self-check failed");
}

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

await build({
  entryPoints: [join(docs, "game.js")],
  bundle: true,
  minify: true,
  format: "esm",
  target: ["es2020"],
  legalComments: "none",
  outfile: join(out, "app.js"),
  logLevel: "warning",
});

const html = await readFile(join(docs, "index.html"), "utf8");
if (!html.includes('src="game.js"')) fail("index.html no longer loads game.js");
await writeFile(join(out, "index.html"), html.replace('src="game.js"', 'src="app.js"'));
await copyFile(join(docs, "style.css"), join(out, "style.css"));
await writeFile(join(out, "vault.json"), `${JSON.stringify(meta)}\n`);
await writeFile(join(out, "vault.bin"), bin);

console.log(
  `✔ Built _site with ${meta.aCount} sealed answer capsules & ${meta.gCount} hashed guesses (${bin.byteLength} bytes)`
);
