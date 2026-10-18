import json
import logging
import os
from config import STORAGE_FILE

logger = logging.getLogger(__name__)


def load_last_post_id() -> str | None:
    """Load the last processed post ID from disk."""
    if not os.path.exists(STORAGE_FILE):
        return None
    try:
        with open(STORAGE_FILE, "r") as f:
            data = json.load(f)
            return data.get("last_post_id")
    except Exception as e:
        logger.warning(f"Failed to load storage file: {e}")
        return None


def save_last_post_id(post_id: str) -> None:
    """Persist the last processed post ID to disk."""
    try:
        with open(STORAGE_FILE, "w") as f:
            json.dump({"last_post_id": post_id}, f)
    except Exception as e:
        logger.error(f"Failed to save post ID to storage: {e}")
