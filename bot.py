# © 2026 Shivam Coder. All rights reserved.
# Instagram Reel/Photo Downloader - Telegram Bot
# Portfolio: https://shivamcoder-portfolio.netlify.app/

import asyncio
import logging
import os
import re
import shutil
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import instaloader
import yt_dlp
from dotenv import load_dotenv
from telegram import InputMediaPhoto, InputMediaVideo, Update
from telegram.ext import (
    ApplicationBuilder,
    CommandHandler,
    ContextTypes,
    MessageHandler,
    filters,
)

load_dotenv()

BOT_TOKEN = os.getenv("BOT_TOKEN", "").strip()
BOT_USERNAME = os.getenv("BOT_USERNAME", "").strip().lstrip("@")
COOKIES_FILE = os.getenv("INSTAGRAM_COOKIES_FILE", "").strip()
MAX_FILE_MB = int(os.getenv("MAX_FILE_MB", "50"))  # Telegram bot upload limit = 50 MB

if not BOT_TOKEN or not BOT_USERNAME:
    raise SystemExit("BOT_TOKEN aur BOT_USERNAME .env me set karo (dekho .env.example)")

logging.basicConfig(
    format="%(asctime)s | %(levelname)s | %(message)s", level=logging.INFO
)
log = logging.getLogger("igbot")

URL_RE = re.compile(
    r"https?://(?:www\.)?(?:instagram\.com|instagr\.am)/(?:[\w.]+/)?"
    r"(?:p|reel|reels|tv)/([\w-]+)[^\s]*",
    re.IGNORECASE,
)
VIDEO_EXT = {".mp4", ".mov", ".mkv", ".webm"}
PHOTO_EXT = {".jpg", ".jpeg", ".png", ".webp"}


def build_caption(original: str) -> str:
    footer = f"📥 Downloaded from @{BOT_USERNAME}\n🔗 https://t.me/{BOT_USERNAME}"
    original = (original or "").strip()
    limit = 1024 - len(footer) - 2  # Telegram caption limit
    if len(original) > limit:
        original = original[: limit - 1] + "…"
    return f"{original}\n\n{footer}" if original else footer


def collect_files(folder: Path):
    files = [
        p for p in sorted(folder.rglob("*")) if p.suffix.lower() in VIDEO_EXT | PHOTO_EXT
    ]
    return files


def run_download(url: str, shortcode: str, workdir: Path):
    """Blocking. Returns (files, original_caption)."""
    caption = ""

    # 1) yt-dlp (reels / videos, kai posts)
    try:
        opts = {
            "outtmpl": str(workdir / "%(autonumber)s.%(ext)s"),
            "format": f"best[filesize<{MAX_FILE_MB}M]/best",
            "quiet": True,
            "noprogress": True,
            "restrictfilenames": True,
        }
        if COOKIES_FILE and Path(COOKIES_FILE).exists():
            opts["cookiefile"] = COOKIES_FILE
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(url, download=True)
        caption = info.get("description") or info.get("title") or ""
    except Exception as e:  # noqa: BLE001
        log.warning("yt-dlp failed: %s", e)

    files = collect_files(workdir)
    if files:
        return files, caption

    # 2) instaloader fallback (photos / carousels)
    try:
        L = instaloader.Instaloader(
            dirname_pattern=str(workdir),
            download_video_thumbnails=False,
            download_geotags=False,
            download_comments=False,
            save_metadata=False,
            compress_json=False,
            post_metadata_txt_pattern="",
            quiet=True,
        )
        post = instaloader.Post.from_shortcode(L.context, shortcode)
        L.download_post(post, target="dl")
        caption = post.caption or ""
    except Exception as e:  # noqa: BLE001
        log.warning("instaloader failed: %s", e)

    return collect_files(workdir), caption


async def send_single(msg, path: Path, caption: str):
    if path.suffix.lower() in VIDEO_EXT:
        await msg.reply_video(
            video=path,
            caption=caption,
            supports_streaming=True,
            read_timeout=180,
            write_timeout=180,
        )
    else:
        try:
            await msg.reply_photo(
                photo=path, caption=caption, read_timeout=120, write_timeout=120
            )
        except Exception:  # photo bohot bada ho to document bhejo
            await msg.reply_document(document=path, caption=caption)


async def handle_link(update: Update, context: ContextTypes.DEFAULT_TYPE):
    msg = update.effective_message
    if not msg or not msg.text:
        return
    m = URL_RE.search(msg.text)
    if not m:
        return

    status = await msg.reply_text("⏳ Download ho raha hai, thoda wait karo...")
    workdir = Path(tempfile.mkdtemp(prefix="igdl_"))
    try:
        files, original = await asyncio.to_thread(
            run_download, m.group(0), m.group(1), workdir
        )
        files = [f for f in files if f.stat().st_size <= MAX_FILE_MB * 1024 * 1024]
        if not files:
            await status.edit_text(
                "❌ Download nahi ho paya. Post private ho sakti hai, link galat ho "
                "sakta hai, ya file 50MB se badi hai."
            )
            return

        caption = build_caption(original)

        if len(files) == 1:
            await send_single(msg, files[0], caption)
        else:
            for i in range(0, len(files), 10):  # album me max 10
                chunk = files[i : i + 10]
                media = []
                for j, f in enumerate(chunk):
                    cap = caption if (i == 0 and j == 0) else None
                    if f.suffix.lower() in VIDEO_EXT:
                        media.append(InputMediaVideo(media=f, caption=cap))
                    else:
                        media.append(InputMediaPhoto(media=f, caption=cap))
                await msg.reply_media_group(
                    media=media, read_timeout=180, write_timeout=180
                )
        await status.delete()
    except Exception as e:  # noqa: BLE001
        log.exception("send failed")
        await status.edit_text(f"❌ Error aaya: {type(e).__name__}. Thodi der baad try karo.")
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.effective_message.reply_text(
        "👋 Namaste! Mujhe koi bhi Instagram Reel / Post / Photo ka link bhejo, "
        "main download karke caption ke saath bhej dunga.\n\n"
        f"Made by Shivam Coder • @{BOT_USERNAME}"
    )


def start_health_server():
    """Kuch hosting (Render/Koyeb etc.) PORT maangti hain - tab ye chalega."""
    port = os.getenv("PORT")
    if not port:
        return

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"Bot is running")

        def log_message(self, *args):
            pass

    server = HTTPServer(("0.0.0.0", int(port)), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    log.info("Health server on port %s", port)


def main():
    start_health_server()
    app = ApplicationBuilder().token(BOT_TOKEN).concurrent_updates(True).build()
    app.add_handler(CommandHandler(["start", "help"], start))
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_link))
    log.info("Bot started as @%s", BOT_USERNAME)
    app.run_polling(drop_pending_updates=True)


if __name__ == "__main__":
    main()
