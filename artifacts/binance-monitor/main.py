"""
Binance Square → Telegram monitor
Polls Binance Square for new posts from Binance-News and forwards them to Telegram.
"""

import asyncio
import logging
import sys

import aiohttp

import binance_client as bc
import telegram_client as tc
from config import POLL_INTERVAL, RETRY_DELAY
from storage import load_last_post_id, save_last_post_id

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s — %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
    stream=sys.stdout,
)
logger = logging.getLogger("monitor")


async def initialize_last_post_id(session: aiohttp.ClientSession) -> str | None:
    """
    On first run (no storage file), fetch the current latest post and mark
    it as seen — so we don't flood the channel with historical posts.
    """
    try:
        posts = await bc.fetch_latest_posts(session)
    except Exception as e:
        logger.error(f"Binance API error during init: {e}")
        return None

    if not posts:
        logger.info("No posts found during initialization — waiting for first post")
        return None

    latest_id = bc.post_id(posts[0])
    save_last_post_id(latest_id)
    logger.info(f"Initialized — skipping history, last postId={latest_id}")
    return latest_id


async def run() -> None:
    logger.info("🚀 Binance Square monitor starting…")

    connector = aiohttp.TCPConnector(limit=5)
    async with aiohttp.ClientSession(connector=connector) as session:

        # ── Load or discover the last processed post ID ──────────────────────
        last_id = load_last_post_id()

        if last_id is None:
            logger.info("No storage found — initializing to current latest post…")
            last_id = await initialize_last_post_id(session)
        else:
            logger.info(f"Resuming from stored postId={last_id}")

        logger.info(f"✅ Ready — polling every {POLL_INTERVAL}s")

        # ── Main polling loop ─────────────────────────────────────────────────
        consecutive_errors = 0

        while True:
            await asyncio.sleep(POLL_INTERVAL)

            try:
                posts = await bc.fetch_latest_posts(session)
                consecutive_errors = 0
            except Exception as e:
                consecutive_errors += 1
                logger.error(f"Binance API error ({consecutive_errors}): {e}")
                # Exponential back-off capped at 60s
                delay = min(RETRY_DELAY * consecutive_errors, 60)
                logger.info(f"Retrying in {delay}s…")
                await asyncio.sleep(delay)
                continue

            # Collect new posts (seen none yet → all are "new" but init already handled that)
            new_posts: list[dict] = []
            for post in posts:
                pid = bc.post_id(post)
                if pid == last_id:
                    break
                new_posts.append(post)

            if not new_posts:
                continue

            # Process oldest-first so Telegram messages appear in chronological order
            new_posts.reverse()

            for post in new_posts:
                pid = bc.post_id(post)
                title = bc.post_title(post)
                logger.info(f"🆕 New post found — id={pid} title={title!r}")

                text = tc.format_message(
                    title=title,
                    content=bc.post_content(post),
                    publish_time=bc.post_publish_time(post),
                    url=bc.post_url(post),
                )

                try:
                    await tc.send_message(session, text)
                except Exception as e:
                    logger.error(f"Telegram error for post {pid}: {e}")
                    # Don't advance last_id so we retry this post next loop

                # Advance cursor even if Telegram failed — prevents infinite retry loops
                # Remove the line below if you want guaranteed Telegram delivery
                last_id = pid
                save_last_post_id(pid)


def main() -> None:
    try:
        asyncio.run(run())
    except KeyboardInterrupt:
        logger.info("Stopped by user (Ctrl+C)")


if __name__ == "__main__":
    main()
