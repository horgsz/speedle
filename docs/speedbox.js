// Speedbox: Cryptographic word & answer obfuscation for Speedle.
// Inspired by Beandle's beanbox.js, adapted for 1,000 4-letter answers + full guess dictionary.
//
// Neither the 1,000 answer words nor the ~6,150 valid guess words are ever shipped in plain text.
// Instead, each build produces:
//   1. A sorted binary Guess Table of 8-byte PBKDF2 hashes for every valid 4-letter guess.
//   2. 1,000 sealed 64-byte Answer Capsules (one per common 4-letter word in schedule order):
//      - 4 x 8-byte per-position PBKDF2 tags (32 bytes) so guesses can be scored for exact/present
//        matches by only testing the letters in the player's guess—without ever decrypting the
//        answer word into memory during gameplay!
//      - 12-byte AES-GCM IV + 20-byte AES-256-GCM ciphertext of the XOR-masked answer letters,
//        protected by a slow PBKDF2 key bound to the capsule digest, used only by reveal()
//        once the round is over.

const VERSION = 1;
const WORD_LENGTH = 4;
const KEY_BYTES = 8;
const CAPSULE_BYTES = 64; // 32B position tags + 12B IV + 20B AES-GCM ciphertext

export const GUESS_ITERATIONS = 1200;
export const TAG_ITERATIONS = 1200;
export const REVEAL_ITERATIONS = 15000;

const SCRAMBLED = [
  211, 44, 189, 102, 77, 230, 15, 168, 92, 141, 203, 58, 19, 244, 117, 83,
  164, 31, 209, 126, 61, 198, 8, 151, 110, 252, 47, 179, 95, 220, 36, 133,
];

const subtle = globalThis.crypto && globalThis.crypto.subtle;
const enc = new TextEncoder();

function pepper() {
  return Uint8Array.from(SCRAMBLED, (b, i) => b ^ ((i * 131 + 73) & 255));
}

function toHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function fromHex(hex) {
  if (typeof hex !== "string" || !/^([0-9a-f]{2})+$/.test(hex)) {
    throw new Error("Bad vault metadata");
  }
  return Uint8Array.from(hex.match(/../g), (h) => parseInt(h, 16));
}

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

async function sha256(...parts) {
  return new Uint8Array(await subtle.digest("SHA-256", concat(...parts)));
}

function compareKey8(table, entryIdx, key8) {
  const base = entryIdx * KEY_BYTES;
  for (let i = 0; i < KEY_BYTES; i++) {
    const d = table[base + i] - key8[i];
    if (d !== 0) return d;
  }
  return 0;
}

function equalBytes(a, aOffset, b, bOffset, len) {
  for (let i = 0; i < len; i++) {
    if (a[aOffset + i] !== b[bOffset + i]) return false;
  }
  return true;
}

/** 8-byte PBKDF2 hash for checking if a 4-letter word is in the allowed guess dictionary. */
async function guessHash(word, guessSalt, iterations) {
  const pep = pepper();
  const base = await subtle.importKey("raw", enc.encode(`guess:${word}`), "PBKDF2", false, ["deriveBits"]);
  const bits = await subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: concat(guessSalt, pep), iterations },
    base,
    64
  );
  pep.fill(0);
  return new Uint8Array(bits);
}

/** 8-byte PBKDF2 tag for letter `ch` at position `pos` (0..3) in capsule `capsuleIdx`. */
async function posTag(ch, capsuleIdx, pos, tagSalt, fragment, iterations) {
  const pep = pepper();
  const idxBytes = new Uint8Array([
    (capsuleIdx >>> 8) & 255,
    capsuleIdx & 255,
    pos & 255,
    ch.charCodeAt(0) & 255,
  ]);
  const base = await subtle.importKey("raw", concat(idxBytes, pep), "PBKDF2", false, ["deriveBits"]);
  const bits = await subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: concat(tagSalt, fragment), iterations },
    base,
    64
  );
  pep.fill(0);
  return new Uint8Array(bits);
}

/** Slow PBKDF2 AES-256-GCM key used only to seal/reveal the 4-letter answer when the round ends. */
async function revealKey(capsuleIdx, revealSalt, fragment, tagsSlice, revealIterations) {
  const pep = pepper();
  const idxBytes = new Uint8Array([(capsuleIdx >>> 8) & 255, capsuleIdx & 255]);
  const tagDigest = await sha256(tagsSlice, idxBytes);
  const material = concat(pep, fragment, idxBytes, tagDigest);
  pep.fill(0);
  const base = await subtle.importKey("raw", material, "PBKDF2", false, ["deriveKey"]);
  material.fill(0);
  return subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt: concat(revealSalt, idxBytes), iterations: revealIterations },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

async function maskBytesFor(capsuleIdx, revealSalt, fragment) {
  const idxBytes = new Uint8Array([(capsuleIdx >>> 8) & 255, capsuleIdx & 255]);
  const h = await sha256(enc.encode("speedle-mask"), revealSalt, fragment, idxBytes);
  return h.subarray(0, WORD_LENGTH);
}

export function isSupported() {
  return !!subtle;
}

/**
 * Build-time function: seals all allowed guesses and all 1,000 common answers into
 * an obfuscated binary table (`bin`) + metadata (`meta`).
 */
export async function sealVault(orderedAnswers, validGuesses, options = {}) {
  const gIter = options.guessIterations || GUESS_ITERATIONS;
  const tIter = options.tagIterations || TAG_ITERATIONS;
  const rIter = options.revealIterations || REVEAL_ITERATIONS;

  const allGuessSet = new Set([...validGuesses, ...orderedAnswers]);
  const guessWords = [...allGuessSet].map((w) => w.toLowerCase()).filter((w) => /^[a-z]{4}$/.test(w));

  const guessSalt = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const tagSalt = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const revealSalt = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const fragment = globalThis.crypto.getRandomValues(new Uint8Array(16));

  // 1. Build sorted 8-byte Guess Table
  const guessEntries = new Array(guessWords.length);
  const BATCH = 512;
  for (let start = 0; start < guessWords.length; start += BATCH) {
    const slice = guessWords.slice(start, start + BATCH);
    const hashes = await Promise.all(slice.map((w) => guessHash(w, guessSalt, gIter)));
    for (let j = 0; j < hashes.length; j++) {
      guessEntries[start + j] = hashes[j];
    }
  }
  guessEntries.sort((a, b) => {
    for (let i = 0; i < KEY_BYTES; i++) {
      if (a[i] !== b[i]) return a[i] - b[i];
    }
    return 0;
  });
  const guessTable = concat(...guessEntries);

  // 2. Build 1,000 sealed Answer Capsules (64 bytes each)
  const capsules = new Uint8Array(orderedAnswers.length * CAPSULE_BYTES);
  const CAP_BATCH = 64;
  for (let start = 0; start < orderedAnswers.length; start += CAP_BATCH) {
    const slice = orderedAnswers.slice(start, start + CAP_BATCH);
    await Promise.all(
      slice.map(async (word, offset) => {
        const k = start + offset;
        const w = word.toLowerCase();
        const cap = new Uint8Array(CAPSULE_BYTES);

        // 4 x 8-byte position tags (bytes 0..31)
        const tags = await Promise.all(
          [0, 1, 2, 3].map((pos) => posTag(w[pos], k, pos, tagSalt, fragment, tIter))
        );
        for (let pos = 0; pos < WORD_LENGTH; pos++) {
          cap.set(tags[pos], pos * KEY_BYTES);
        }

        // 12-byte IV (bytes 32..43)
        const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
        cap.set(iv, 32);

        // 20-byte AES-GCM sealed word (bytes 44..63)
        const masks = await maskBytesFor(k, revealSalt, fragment);
        const maskedWord = new Uint8Array(WORD_LENGTH);
        for (let i = 0; i < WORD_LENGTH; i++) {
          maskedWord[i] = w.charCodeAt(i) ^ masks[i];
        }
        const key = await revealKey(k, revealSalt, fragment, cap.subarray(0, 32), rIter);
        const aad = enc.encode(`speedle:${k}`);
        const sealed = new Uint8Array(
          await subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad }, key, maskedWord)
        );
        cap.set(sealed, 44);

        capsules.set(cap, k * CAPSULE_BYTES);
      })
    );
  }

  const bin = concat(guessTable, capsules);
  const digest = await sha256(bin);

  const meta = {
    v: VERSION,
    h: toHex(digest.subarray(0, 8)),
    gCount: guessWords.length,
    aCount: orderedAnswers.length,
    gi: gIter,
    ti: tIter,
    ri: rIter,
    gs: toHex(guessSalt),
    ts: toHex(tagSalt),
    rs: toHex(revealSalt),
    k: toHex(fragment),
  };

  return { meta, bin };
}

/**
 * Browser runtime function: opens `vault.json` + `vault.bin` and provides opaque puzzle
 * objects that can score guesses and reveal the answer after a game without holding plaintext words.
 */
export function openVault(meta, binBytes) {
  if (!meta || meta.v !== VERSION) throw new Error("Invalid vault metadata");
  const bin = binBytes instanceof Uint8Array ? binBytes : new Uint8Array(binBytes);
  const gCount = Number(meta.gCount);
  const aCount = Number(meta.aCount);
  const gIter = Number(meta.gi) || GUESS_ITERATIONS;
  const tIter = Number(meta.ti) || TAG_ITERATIONS;
  const rIter = Number(meta.ri) || REVEAL_ITERATIONS;

  const guessTableBytes = gCount * KEY_BYTES;
  const expectedBytes = guessTableBytes + aCount * CAPSULE_BYTES;
  if (bin.length !== expectedBytes) throw new Error("Corrupted vault binary");

  const guessTable = bin.subarray(0, guessTableBytes);
  const capsules = bin.subarray(guessTableBytes);

  const guessSalt = fromHex(meta.gs);
  const tagSalt = fromHex(meta.ts);
  const revealSalt = fromHex(meta.rs);
  const fragment = fromHex(meta.k);

  async function isAllowedGuess(word) {
    if (typeof word !== "string" || !/^[a-z]{4}$/.test(word)) return false;
    const h = await guessHash(word, guessSalt, gIter);
    let lo = 0;
    let hi = gCount - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const cmp = compareKey8(guessTable, mid, h);
      if (cmp === 0) return true;
      if (cmp < 0) lo = mid + 1;
      else hi = mid - 1;
    }
    return false;
  }

  function getPuzzle(index) {
    const k = ((index % aCount) + aCount) % aCount;
    const capBase = k * CAPSULE_BYTES;
    const cap = capsules.subarray(capBase, capBase + CAPSULE_BYTES);

    return {
      index: k,

      /**
       * Scores a 4-letter guess against capsule `k` without decrypting the answer.
       * Returns ["correct" | "present" | "absent", ...] or null if not in the dictionary.
       */
      async score(guess) {
        if (typeof guess !== "string") return null;
        const g = guess.trim().toLowerCase();
        if (!/^[a-z]{4}$/.test(g)) return null;
        if (!(await isAllowedGuess(g))) return null;

        // Compute candidate tags only for the unique letters present in `g` across positions 0..3
        const uniqueChars = [...new Set(g)];
        const matchMatrix = {};
        for (const ch of uniqueChars) {
          const charTags = await Promise.all(
            [0, 1, 2, 3].map((pos) => posTag(ch, k, pos, tagSalt, fragment, tIter))
          );
          matchMatrix[ch] = [0, 1, 2, 3].map((pos) =>
            equalBytes(cap, pos * KEY_BYTES, charTags[pos], 0, KEY_BYTES)
          );
        }

        const result = Array(WORD_LENGTH).fill("absent");
        const answerSlotConsumed = [false, false, false, false];

        // Pass 1: exact position ("correct") matches
        for (let i = 0; i < WORD_LENGTH; i++) {
          const ch = g[i];
          if (matchMatrix[ch][i]) {
            result[i] = "correct";
            answerSlotConsumed[i] = true;
          }
        }

        // Pass 2: wrong-spot ("present") matches respecting duplicate counts
        for (let i = 0; i < WORD_LENGTH; i++) {
          if (result[i] === "correct") continue;
          const ch = g[i];
          for (let pos = 0; pos < WORD_LENGTH; pos++) {
            if (!answerSlotConsumed[pos] && matchMatrix[ch][pos]) {
              result[i] = "present";
              answerSlotConsumed[pos] = true;
              break;
            }
          }
        }

        return result;
      },

      /**
       * Decrypts and reveals the 4-letter word. Only called after a round ends.
       */
      async reveal() {
        const tagsSlice = cap.subarray(0, 32);
        const iv = cap.subarray(32, 44);
        const ciphertext = cap.subarray(44, 64);
        const key = await revealKey(k, revealSalt, fragment, tagsSlice, rIter);
        const aad = enc.encode(`speedle:${k}`);
        const masked = new Uint8Array(
          await subtle.decrypt({ name: "AES-GCM", iv, additionalData: aad }, key, ciphertext)
        );
        const masks = await maskBytesFor(k, revealSalt, fragment);
        const chars = new Uint8Array(WORD_LENGTH);
        for (let i = 0; i < WORD_LENGTH; i++) {
          chars[i] = masked[i] ^ masks[i];
        }
        const word = String.fromCharCode(...chars);
        chars.fill(0);
        masked.fill(0);
        if (!/^[a-z]{4}$/.test(word)) throw new Error("Bad puzzle reveal");
        return word;
      },
    };
  }

  return {
    answerCount: aCount,
    guessCount: gCount,
    isAllowedGuess,
    getPuzzle,
  };
}
