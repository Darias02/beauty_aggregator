import os

from aiogram import Bot, Dispatcher
from dotenv import load_dotenv

from bot.handlers.start import router as start_router
from bot.handlers.booking import router as booking_router
from bot.handlers.slot import router as slot_router


load_dotenv()


BOT_TOKEN = os.getenv("BOT_TOKEN")


if not BOT_TOKEN:
    raise RuntimeError(
        "Переменная BOT_TOKEN не найдена в файле .env"
    )


bot = Bot(token=BOT_TOKEN)

dp = Dispatcher()


dp.include_router(start_router)
dp.include_router(booking_router)
dp.include_router(slot_router)


async def main() -> None:
    print("Бот BB успешно запущен и готов к работе.")

    try:
        await dp.start_polling(bot)
    finally:
        await bot.session.close()