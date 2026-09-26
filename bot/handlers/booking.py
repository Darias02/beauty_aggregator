from aiogram import Router
from aiogram.filters import Command
from aiogram.types import (
    Message,
    InlineKeyboardButton,
    InlineKeyboardMarkup,
    WebAppInfo,
)

router = Router()


WEBAPP_URL = "https://beauty-aggregator-indol.vercel.app"


def open_app_keyboard() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(
        inline_keyboard=[
            [
                InlineKeyboardButton(
                    text="Открыть BB",
                    web_app=WebAppInfo(url=WEBAPP_URL),
                )
            ]
        ]
    )


@router.message(Command("book"))
async def open_booking_app(message: Message):
    await message.answer(
        "Откройте BB, чтобы выбрать услугу " "и записаться на слот.",
        reply_markup=open_app_keyboard(),
    )
