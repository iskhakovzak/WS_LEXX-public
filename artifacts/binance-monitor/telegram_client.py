import logging

import aiohttp

from config import REQUEST_TIMEOUT, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID

logger = logging.getLogger(__name__)

TELEGRAM_API = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}"


def _escape(text: str) -> str:
    """Escape characters that break Telegram MarkdownV2."""
    for ch in r"\_*[]()~`>#+-=|{}.!":
        text = text.replace(ch, f"\\{ch}")
    return text


def format_message(title: str, content: str, publish_time: str, url: str) -> str:
    """Build Telegram message text (plain, no special Markdown)."""
    lines = [
        "🚨 Binance News",
        "",
    ]
    if title:
        lines += [f"Title: {title}", ""]
    if content:
        # Truncate very long content to avoid Telegram 4096-char limit
        if len(content) > 3500:
            content = content[:3497] + "…"
        lines.append(content)
        lines.append("")
    lines += [
        f"Published:\n{publish_time}",
        "",
        f"Link:\n{url}",
    ]
    return "\n".join(lines)


async def send_message(session: aiohttp.ClientSession, text: str) -> None:
    """Send a plain-text message to the configured Telegram chat."""
    url = f"{TELEGRAM_API}/sendMessage"
    payload = {
        "chat_id": TELEGRAM_CHAT_ID,
        "text": text,
        "disable_web_page_preview": False,
    }

    async with session.post(
        url,
        json=payload,
        timeout=aiohttp.ClientTimeout(total=REQUEST_TIMEOUT),
    ) as resp:
        body = await resp.json(content_type=None)
        if resp.status != 200 or not body.get("ok"):
            err = body.get("description", "unknown error")
            logger.error(f"Telegram API error {resp.status}: {err}")
            raise RuntimeError(f"Telegram send failed: {err}")

    logger.info("✅ Message sent to Telegram")
