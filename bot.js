// © 2026 Shivam Coder. All rights reserved.
// Instagram Reel/Photo Downloader - Telegram Bot (Node.js)
// Portfolio: https://shivamcoder-portfolio.netlify.app/

require("dotenv").config();
const { Telegraf } = require("telegraf");
const { execFile } = require("child_process");
const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const http = require("http");
const { Readable } = require("stream");
const { pipeline } = require("stream/promises");

const BOT_TOKEN = (process.env.BOT_TOKEN || "").trim();
const BOT_USERNAME = (process.env.BOT_USERNAME || "").trim().replace(/^@/, "");
const COOKIES_FILE = (process.env.INSTAGRAM_COOKIES_FILE || "").trim();
const MAX_FILE_MB = parseInt(process.env.MAX_FILE_MB || "50", 10);
const YTDLP_PATH =
  (process.env.YTDLP_PATH || "").trim() || path.join(__dirname, "yt-dlp");

if (!BOT_TOKEN || !BOT_USERNAME) {
  console.error("BOT_TOKEN aur BOT_USERNAME set karo (dekho .env.example)");
  process.exit(1);
}

const URL_RE =
  /https?:\/\/(?:www\.)?(?:instagram\.com|instagr\.am)\/(?:[\w.]+\/)?(?:p|reel|reels|tv)\/([\w-]+)[^\s]*/i;
const VIDEO_EXT = new Set([".mp4", ".mov", ".mkv", ".webm"]);
const PHOTO_EXT = new Set([".jpg", ".jpeg", ".png", ".webp"]);

// ---------- yt-dlp binary (python ki zaroorat nahi, standalone download) ----------
async function ensureYtDlp() {
  if (fs.existsSync(YTDLP_PATH)) return;
  const isWin = process.platform === "win32";
  const isMac = process.platform === "darwin";
  const asset = isWin ? "yt-dlp.exe" : isMac ? "yt-dlp_macos" : "yt-dlp_linux";
  const url = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${asset}`;
  console.log("yt-dlp download ho raha hai:", url);
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error("yt-dlp download fail: " + res.status);
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(YTDLP_PATH));
  if (!isWin) await fsp.chmod(YTDLP_PATH, 0o755);
}

// ---------- caption ----------
function buildCaption(original) {
  const footer = `📥 Downloaded from @${BOT_USERNAME}\n🔗 https://t.me/${BOT_USERNAME}`;
  let text = (original || "").trim();
  const limit = 1024 - footer.length - 2; // Telegram caption limit
  if (text.length > limit) text = text.slice(0, limit - 1) + "…";
  return text ? `${text}\n\n${footer}` : footer;
}

// ---------- download ----------
function runYtDlp(url, dir) {
  const args = [
    "--no-warnings",
    "--no-playlist-reverse",
    "--restrict-filenames",
    "-o",
    path.join(dir, "%(autonumber)s.%(ext)s"),
    "-f",
    `best[filesize<${MAX_FILE_MB}M]/best`,
    "--dump-single-json",
    "--no-simulate",
  ];
  if (COOKIES_FILE && fs.existsSync(COOKIES_FILE)) {
    args.push("--cookies", COOKIES_FILE);
  }
  args.push(url);

  return new Promise((resolve, reject) => {
    execFile(
      YTDLP_PATH,
      args,
      { maxBuffer: 1024 * 1024 * 64, timeout: 4 * 60 * 1000 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error((stderr || err.message).slice(0, 300)));
        try {
          resolve(JSON.parse(stdout));
        } catch {
          resolve({});
        }
      }
    );
  });
}

async function collectFiles(dir) {
  const names = (await fsp.readdir(dir)).sort();
  const files = [];
  for (const n of names) {
    const ext = path.extname(n).toLowerCase();
    if (VIDEO_EXT.has(ext) || PHOTO_EXT.has(ext)) {
      const full = path.join(dir, n);
      const st = await fsp.stat(full);
      if (st.size <= MAX_FILE_MB * 1024 * 1024) files.push(full);
    }
  }
  return files;
}

const isVideo = (f) => VIDEO_EXT.has(path.extname(f).toLowerCase());

// ---------- bot ----------
const bot = new Telegraf(BOT_TOKEN, { handlerTimeout: 5 * 60 * 1000 });

bot.start((ctx) =>
  ctx.reply(
    "👋 Namaste! Mujhe koi bhi Instagram Reel / Post / Photo ka link bhejo, " +
      "main download karke caption ke saath bhej dunga.\n\n" +
      `Made by Shivam Coder • @${BOT_USERNAME}`
  )
);
bot.help((ctx) => ctx.reply("Bas Instagram ka link bhejo, baaki main dekh lunga 🙂"));

bot.on("text", async (ctx) => {
  const m = ctx.message.text.match(URL_RE);
  if (!m) return;

  const status = await ctx.reply("⏳ Download ho raha hai, thoda wait karo...");
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "igdl_"));

  try {
    let info = {};
    try {
      info = await runYtDlp(m[0], dir);
    } catch (e) {
      console.warn("yt-dlp failed:", e.message);
    }

    const files = await collectFiles(dir);
    if (!files.length) {
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        status.message_id,
        undefined,
        "❌ Download nahi ho paya. Post private ho sakti hai, link galat ho sakta hai, " +
          "Instagram ne block kiya ho sakta hai (cookies use karo), ya file 50MB se badi hai."
      );
      return;
    }

    const caption = buildCaption(info.description || info.title || "");
    const reply = { reply_to_message_id: ctx.message.message_id };

    if (files.length === 1) {
      const f = files[0];
      if (isVideo(f)) {
        await ctx.replyWithVideo({ source: f }, { caption, supports_streaming: true, ...reply });
      } else {
        try {
          await ctx.replyWithPhoto({ source: f }, { caption, ...reply });
        } catch {
          await ctx.replyWithDocument({ source: f }, { caption, ...reply });
        }
      }
    } else {
      for (let i = 0; i < files.length; i += 10) {
        const chunk = files.slice(i, i + 10).map((f, j) => ({
          type: isVideo(f) ? "video" : "photo",
          media: { source: f },
          ...(i === 0 && j === 0 ? { caption } : {}),
        }));
        await ctx.replyWithMediaGroup(chunk, reply);
      }
    }
    await ctx.telegram.deleteMessage(ctx.chat.id, status.message_id).catch(() => {});
  } catch (e) {
    console.error(e);
    await ctx.telegram
      .editMessageText(
        ctx.chat.id,
        status.message_id,
        undefined,
        "❌ Error aaya. Thodi der baad try karo."
      )
      .catch(() => {});
  } finally {
    fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

bot.catch((err) => console.error("Bot error:", err));

// Kuch hosting PORT maangti hain - tab ye health server chalega
if (process.env.PORT) {
  http
    .createServer((_, res) => {
      res.writeHead(200);
      res.end("Bot is running");
    })
    .listen(process.env.PORT, () => console.log("Health server on", process.env.PORT));
}

(async () => {
  await ensureYtDlp();
  await bot.launch({ dropPendingUpdates: true });
  console.log(`Bot started as @${BOT_USERNAME}`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
