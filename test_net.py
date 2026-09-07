import os
import requests
from dotenv import load_dotenv

load_dotenv()
TOKEN = os.getenv('BOT_TOKEN')
URL = f"https://api.telegram.org/bot{TOKEN}/getMe"

print("Пробуем подключиться к Telegram...")
try:
    response = requests.get(URL, timeout=10)
    print("УРА! Ответ от сервера:", response.json())
except Exception as e:
    print("Ошибка сети:", e)