import os

from dotenv import load_dotenv
from supabase import Client, create_client


load_dotenv()


SUPABASE_URL = os.getenv(
    "SUPABASE_URL"
)

SUPABASE_KEY = os.getenv(
    "SUPABASE_KEY"
)


if not SUPABASE_URL:
    raise RuntimeError(
        "Переменная SUPABASE_URL не найдена в .env"
    )


if not SUPABASE_KEY:
    raise RuntimeError(
        "Переменная SUPABASE_KEY не найдена в .env"
    )


supabase: Client = create_client(
    SUPABASE_URL,
    SUPABASE_KEY,
)