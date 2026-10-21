# ⚡ Speedle

A fast-paced 30-second arcade variant of Wordle for **4-letter words** using the **1,000 most common 4-letter English words**.

🔗 **Play Live:** [https://horgsz.github.io/speedle/](https://horgsz.github.io/speedle/)

## Features
- **4-Letter Words, 6 Guesses, 30-Second Clock:** The timer starts on your first keypress.
- **+3.0s Checkpoint Time Bonus:** Every valid non-winning guess adds `+3.0s` to your remaining time (capped at `30.0s`).
- **Arcade Multiplier Scoring:** `Score = (Row Multiplier) × round(Seconds Remaining × 10)` (up to `1,800 PTS`).
- **Shifting Correct-Tile Hue Spectrum:** Correct tiles shift across 6 green/teal hues depending on which attempt you solve them on:
  - **1st Try (6×):** `#00f5d4` Electric Cyan-Mint (`⚡ LIGHTNING`)
  - **2nd Try (5×):** `#00e676` Neon Emerald (`🔥 SUPERSONIC`)
  - **3rd Try (4×):** `#1db954` Vibrant Green (`🚀 TURBO`)
  - **4th Try (3×):** `#2e9e5b` Classic Green (`💨 SWIFT`)
  - **5th Try (2×):** `#4b8b5f` Sage Green (`⏱️ CRUISING`)
  - **6th Try (1×):** `#647a61` Muted Moss (`😅 BUZZER BEATER`)
- **Daily + Unlimited Arcade Modes:** Play the shared Daily Speedle or switch to **⚡ Arcade** for endless 30-second rounds.

## Local Development

```bash
npm test
npm run serve
```
Then open `http://localhost:8000` in your browser.
