import logging
from typing import Any

import aiohttp

from config import (
    BINANCE_API_URL,
    BINANCE_PAGE_SIZE,
    BINANCE_PROFILE_ID,
    REQUEST_TIMEOUT,
)

logger = logging.getLogger(__name__)

HEADERS = {
    "Content-Type": "application/json",
    "Accept": "application/json",
    "clienttype": "web",
    "lang": "en",
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/120.0.0.0 Safari/537.36"
    ),
}


def _parse_posts(data: dict) -> list[dict[str, Any]]:
    """Extract post list from API response, tolerating different shapes."""
    if not isinstance(data, dict):
        return []
    payload = data.get("data") or {}
    posts = payload.get("list") or payload.get("feeds") or payload.get("posts") or []
    return posts if isinstance(posts, list) else []


async def fetch_latest_posts(
    session: aiohttp.ClientSession,
    cursor: str = "",
) -> list[dict[str, Any]]:
    """
    Fetch the latest posts from Binance Square.

    Returns a list of post dicts ordered newest-first.
    Raises on HTTP or API errors so the caller can retry.
    """
    body = {
        "profileId": BINANCE_PROFILE_ID,
        "pageSize": BINANCE_PAGE_SIZE,
        "cursor": cursor,
        "type": 0,
    }

    async with session.post(
        BINANCE_API_URL,
        json=body,
        headers=HEADERS,
        timeout=aiohttp.ClientTimeout(total=REQUEST_TIMEOUT),
    ) as resp:
        if resp.status != 200:
            logger.error(f"Binance API HTTP error: {resp.status}")
            resp.raise_for_status()

        data = await resp.json(content_type=None)
        code = data.get("code", "")

        if code != "000000":
            msg = data.get("message") or data.get("msg") or "unknown"
            logger.error(f"Binance API error code={code} message={msg}")
            raise RuntimeError(f"Binance API returned code={code}: {msg}")

        posts = _parse_posts(data)
        logger.debug(f"Fetched {len(posts)} posts from Binance Square")
        return posts


def post_id(post: dict) -> str:
    """Return a stable string ID for a post (handles different field names)."""
    return str(
        post.get("postId")
        or post.get("id")
        or post.get("articleId")
        or ""
    )


def post_title(post: dict) -> str:
    return (post.get("title") or "").strip()


def post_content(post: dict) -> str:
    raw = post.get("content") or post.get("body") or ""
    # Strip simple HTML tags if present
    import re
    text = re.sub(r"<[^>]+>", "", str(raw))
    return text.strip()


def post_publish_time(post: dict) -> str:
    import datetime
    ts = post.get("pubTime") or post.get("publishTime") or post.get("createTime")
    if ts:
        try:
            dt = datetime.datetime.utcfromtimestamp(int(ts) / 1000)
            return dt.strftime("%Y-%m-%d %H:%M:%S UTC")
        except Exception:
            return str(ts)
    return "—"


def post_url(post: dict) -> str:
    link = (
        post.get("shareLink")
        or post.get("link")
        or post.get("url")
        or ""
    )
    if link:
        return str(link)
    pid = post_id(post)
    if pid:
        return f"https://www.binance.com/en/square/post/{pid}"
    return "https://www.binance.com/en/square/profile/Binance-News"
