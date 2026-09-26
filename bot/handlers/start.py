import os

from aiogram import Router
from aiogram.filters import Command, CommandStart
from aiogram.types import (
    InlineKeyboardButton,
    InlineKeyboardMarkup,
    Message,
)
from aiogram.types.web_app_info import WebAppInfo

from database.repositories.users import add_user


router = Router()


WEB_APP_URL = os.getenv(
    "WEB_APP_URL",
    "https://beauty-aggregator-indol.vercel.app",
)


@router.message(CommandStart())
async def cmd_start(message: Message) -> None:
    user = message.from_user

    if user is None:
        return

    add_user(
        user_id=user.id,
        name=user.full_name,
    )

    await message.answer(
        f"Привет, {user.full_name}! 💅🏿\n\n"
        "Добро пожаловать в BB — сервис онлайн-записи.\n\n"
        "Чтобы открыть приложение, нажмите кнопку ниже."
    )


@router.message(Command("app"))
async def cmd_app(message: Message) -> None:
    keyboard = InlineKeyboardMarkup(
        inline_keyboard=[
            [
                InlineKeyboardButton(
                    text="Открыть приложение",
                    web_app=WebAppInfo(url=WEB_APP_URL),
                )
            ]
        ]
    )

    await message.answer(
        "Открыть BB:",
        reply_markup=keyboard,
    )
