from datetime import datetime

from aiogram import Router
from aiogram.filters import Command
from aiogram.fsm.context import FSMContext
from aiogram.fsm.state import State, StatesGroup
from aiogram.types import (
    CallbackQuery,
    InlineKeyboardButton,
    InlineKeyboardMarkup,
    Message,
)

from database.repositories.masters import (
    check_is_master,
)
from database.repositories.services import (
    get_all_services,
)
from database.repositories.slots import (
    add_new_slot,
)


router = Router()


class SlotCreate(StatesGroup):
    service_id = State()
    date_time = State()
    confirm = State()


@router.message(Command("add_slot"))
async def cmd_add_slot(
    message: Message,
    state: FSMContext,
) -> None:
    user = message.from_user

    if user is None:
        return

    master_id = user.id

    if not check_is_master(master_id):
        await message.answer("Эта команда доступна только мастерам.")
        return

    services = get_all_services()

    if not services:
        await message.answer("Список услуг пока пуст.")
        return

    keyboard_buttons = []

    for service in services:
        keyboard_buttons.append(
            [
                InlineKeyboardButton(
                    text=service["name"],
                    callback_data=("addslot_srv_" f"{service['service_id']}"),
                )
            ]
        )

    keyboard = InlineKeyboardMarkup(inline_keyboard=keyboard_buttons)

    await message.answer(
        "Выберите услугу, для которой хотите создать слот:",
        reply_markup=keyboard,
    )

    await state.set_state(SlotCreate.service_id)


@router.callback_query(
    SlotCreate.service_id,
    lambda callback: (
        callback.data is not None and callback.data.startswith("addslot_srv_")
    ),
)
async def process_slot_service(
    callback: CallbackQuery,
    state: FSMContext,
) -> None:
    if not callback.data:
        await callback.answer()
        return

    service_id = int(callback.data.split("_")[2])

    await state.update_data(service_id=service_id)

    if callback.message:
        await callback.message.edit_text(
            "Отлично!\n\n"
            "Теперь введите дату и время для слота "
            "в формате:\n"
            "ДД.ММ.ГГГГ ЧЧ:ММ\n\n"
            "Например:\n"
            "30.09.2026 14:00"
        )

    await state.set_state(SlotCreate.date_time)

    await callback.answer()


@router.message(SlotCreate.date_time)
async def process_slot_datetime(
    message: Message,
    state: FSMContext,
) -> None:
    if not message.text:
        await message.answer("Введите дату и время текстом.")
        return

    try:
        dt = datetime.strptime(
            message.text.strip(),
            "%d.%m.%Y %H:%M",
        )
    except ValueError:
        await message.answer(
            "Неверный формат.\n\n"
            "Используйте:\n"
            "ДД.ММ.ГГГГ ЧЧ:ММ\n\n"
            "Например:\n"
            "30.09.2026 14:00"
        )
        return

    await state.update_data(date_time=dt.isoformat())

    keyboard = InlineKeyboardMarkup(
        inline_keyboard=[
            [
                InlineKeyboardButton(
                    text="Опубликовать",
                    callback_data="publish_slot",
                )
            ],
            [
                InlineKeyboardButton(
                    text="Отмена",
                    callback_data="cancel_slot",
                )
            ],
        ]
    )

    await message.answer(
        (
            "Вы указали:\n"
            f"{dt.strftime('%d.%m.%Y %H:%M')}\n\n"
            "Готовы опубликовать слот?"
        ),
        reply_markup=keyboard,
    )

    await state.set_state(SlotCreate.confirm)


@router.callback_query(
    SlotCreate.confirm,
    lambda callback: (callback.data == "publish_slot"),
)
async def publish_slot(
    callback: CallbackQuery,
    state: FSMContext,
) -> None:
    data = await state.get_data()

    service_id = data.get("service_id")

    date_time = data.get("date_time")

    if not service_id or not date_time:
        await callback.answer(
            "Данные слота потеряны.",
            show_alert=True,
        )
        return

    success = add_new_slot(
        master_id=callback.from_user.id,
        service_id=service_id,
        date_time=date_time,
    )

    if not success:
        await callback.answer(
            "У вас уже есть слот на это время.",
            show_alert=True,
        )

        await state.set_state(SlotCreate.date_time)

        if callback.message:
            await callback.message.edit_text(
                "Введите другую дату и время:\n\n" "ДД.ММ.ГГГГ ЧЧ:ММ"
            )

        return

    if callback.message:
        await callback.message.edit_text(
            "Слот опубликован! \n\n" "Теперь клиенты смогут на него записаться."
        )

    await state.clear()

    await callback.answer()


@router.callback_query(
    SlotCreate.confirm,
    lambda callback: (callback.data == "cancel_slot"),
)
async def cancel_slot(
    callback: CallbackQuery,
    state: FSMContext,
) -> None:
    await state.clear()

    if callback.message:
        await callback.message.edit_text("Создание слота отменено.")

    await callback.answer()
