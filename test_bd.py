import os
from dotenv import load_dotenv
from supabase import create_client, Client

# Загружаем ключи из твоего файла .env
load_dotenv()

url: str = os.environ.get("SUPABASE_URL")
key: str = os.environ.get("SUPABASE_KEY")

# Создаем подключение к базе
supabase: Client = create_client(url, key)

try:
    # Пробуем запросить все записи из таблицы services (или users)
    response = supabase.table("services").select("*").execute()
    
    print("Успешное подключение! 🙌🏿")
    print("Данные из базы:", response.data)
except Exception as e:
    print("Что-то пошло не так:", e)