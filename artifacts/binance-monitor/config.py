import os

# ─── Binance Square API ────────────────────────────────────────────────────────
# To replace endpoint if Binance changes it, update BINANCE_API_URL
BINANCE_API_URL = "https://www.binance.com/bapi/composite/v1/public/cms/get-square-profile-posts"

# Profile username shown in the URL:
# https://www.binance.com/en/square/profile/Binance-News
BINANCE_PROFILE_ID = "Binance-News"

# Number of posts to fetch per request (keep small to get latest quickly)
BINANCE_PAGE_SIZE = 10

# Polling interval in seconds
POLL_INTERVAL = 0.8

# Request timeout (seconds)
REQUEST_TIMEOUT = 10

# Retry delay on error (seconds)
RETRY_DELAY = 5

# ─── Telegram ─────────────────────────────────────────────────────────────────
TELEGRAM_BOT_TOKEN = os.environ["TELEGRAM_BOT_TOKEN"]
TELEGRAM_CHAT_ID = os.environ["TELEGRAM_CHAT_ID"]

# ─── Storage ──────────────────────────────────────────────────────────────────
# File to persist the last processed post ID between restarts
STORAGE_FILE = "last_post_id.json"
