import asyncio
import os
from datetime import datetime
from aiogram import Bot, Dispatcher
from aiogram.filters import CommandStart, Command
from aiogram.types import Message, InlineKeyboardMarkup, InlineKeyboardButton, CallbackQuery
from aiogram.fsm.context import FSMContext
from aiogram.fsm.state import State, StatesGroup
from aiogram.types.web_app_info import WebAppInfo
from dotenv import load_dotenv

# Импортируем все нужные функции из нашего модуля базы данных
from database import (
    add_user, get_available_services, get_available_slots, 
    create_booking, confirm_booking_db, reject_booking_db, 
    check_is_master, get_all_services, add_new_slot
)
import socket

# Принудительно заставляем макбук использовать IPv4 для Telegram
old_getaddrinfo = socket.getaddrinfo
def new_getaddrinfo(*args, **kwargs):
    responses = old_getaddrinfo(*args, **kwargs)
    return [res for res in responses if res[0] == socket.AF_INET]
socket.getaddrinfo = new_getaddrinfo
load_dotenv()
TOKEN = os.getenv('BOT_TOKEN')

bot = Bot(token=TOKEN)
dp = Dispatcher()

# --- СТАРТ ---
@dp.message(CommandStart())
async def cmd_start(message: Message):
    tg_id = message.from_user.id
    tg_name = message.from_user.full_name
    
    add_user(user_id=tg_id, name=tg_name)
    
    await message.answer(
        f"Привет, {tg_name}! 💅🏿 Добро пожаловать в сервис онлайн-записи.\n"
        "Для просмотра доступных услуг отправь /book\n"
        "Для запуска Mini App отправь /app"
    )

# --- ОТКРЫТИЕ MINI APP ---
@dp.message(Command("app"))
async def cmd_app(message: Message):
    web_app_url = "https://6aa6c51ef6f8260ce73f22bf--grand-shortbread-3b37a1.netlify.app/"
    keyboard = InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(text="📱 Открыть приложение", web_app=WebAppInfo(url=web_app_url))]
    ])
    await message.answer("Давай протестируем наш интерфейс!", reply_markup=keyboard)

# --- ПРОСМОТР УСЛУГ (/book) ---
@dp.message(Command("book"))
async def show_available_services(message: Message):
    user_id = message.from_user.id
    services = get_available_services(user_id)

    if not services:
        await message.answer("К сожалению, сейчас нет доступных окошек для записи. Загляните позже! ✨")
        return

    keyboard_buttons = [[InlineKeyboardButton(text=srv['name'], callback_data=f"service_{srv['service_id']}")] for srv in services]
    keyboard = InlineKeyboardMarkup(inline_keyboard=keyboard_buttons)
    await message.answer("Выберите услугу, на которую хотите записаться:", reply_markup=keyboard)

# --- ВЫБОР ВРЕМЕНИ ДЛЯ УСЛУГИ ---
@dp.callback_query(lambda c: c.data.startswith("service_"))
async def process_service_selection(callback: CallbackQuery):
    service_id = int(callback.data.split("_")[1])
    user_id = callback.from_user.id
    
    slots = get_available_slots(service_id, user_id)

    if not slots:
        await callback.message.answer("К сожалению, на эту услугу пока нет свободных окошек.")
        await callback.answer()
        return

    keyboard_buttons = []
    for slot in slots:
        # Парсим строку времени из базы (ISO формат) в красивый вид
        dt = datetime.fromisoformat(slot['date_time'].replace('Z', '+00:00'))
        formatted_time = dt.strftime("%d.%m.%Y %H:%M")
        keyboard_buttons.append([InlineKeyboardButton(text=formatted_time, callback_data=f"slot_{slot['slot_id']}")])

    keyboard = InlineKeyboardMarkup(inline_keyboard=keyboard_buttons)
    await callback.message.edit_text("Выберите удобное время для записи:", reply_markup=keyboard)
    await callback.answer()

# --- МОДЕЛЬ БРОНИРУЕТ СЛОТ ---
@dp.callback_query(lambda c: c.data.startswith("slot_"))
async def process_slot_booking(callback: CallbackQuery):
    slot_id = int(callback.data.split("_")[1])
    user_id = callback.from_user.id
    full_name = callback.from_user.full_name

    booking_data = create_booking(user_id, slot_id)
    if not booking_data:
        await callback.message.edit_text("К сожалению, этот слот уже занят или ожидает подтверждения! 😢")
        await callback.answer()
        return

    formatted_time = booking_data['date_time'].strftime('%d.%m.%Y %H:%M')
    await callback.message.edit_text(
        f"Заявка на {booking_data['service_name']} ({formatted_time}) отправлена!\n"
        "Ожидайте подтверждения от мастера ✨"
    )
    await callback.answer()

    master_keyboard = InlineKeyboardMarkup(inline_keyboard=[
        [
            InlineKeyboardButton(text="✅ Подтвердить", callback_data=f"confirm_{booking_data['booking_id']}"),
            InlineKeyboardButton(text="❌ Отклонить", callback_data=f"reject_{booking_data['booking_id']}")
        ]
    ])

    try:
        await bot.send_message(
            chat_id=booking_data['master_id'],
            text=f"🔔 Новая заявка на бронирование!\n\n"
                 f"👤 Модель: {full_name}\n"
                 f"💅 Услуга: {booking_data['service_name']}\n"
                 f"📅 Время: {formatted_time}\n\n"
                 f"Подтверждаете запись?",
            reply_markup=master_keyboard
        )
    except Exception as e:
        print(f"Не удалось отправить сообщение мастеру: {e}")

# --- МАСТЕР ПОДТВЕРЖДАЕТ БРОНЬ ---
@dp.callback_query(lambda c: c.data.startswith("confirm_"))
async def confirm_booking(callback: CallbackQuery):
    booking_id = int(callback.data.split("_")[1])
    client_id = confirm_booking_db(booking_id)

    await callback.message.edit_text("✅ Вы успешно подтвердили запись! Модели отправлено уведомление.")
    await callback.answer()

    if client_id:
        await bot.send_message(chat_id=client_id, text="✅ Ура! Мастер подтвердил вашу запись. Ждем вас на процедуру! ✨")

# --- МАСТЕР ОТКЛОНЯЕТ БРОНЬ ---
@dp.callback_query(lambda c: c.data.startswith("reject_"))
async def ask_reject_reason(callback: CallbackQuery):
    booking_id = int(callback.data.split("_")[1])
    reason_keyboard = InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(text="Изменились планы", callback_data=f"reason_plans_{booking_id}")],
        [InlineKeyboardButton(text="Модель не подходит", callback_data=f"reason_model_{booking_id}")]
    ])
    await callback.message.edit_text("Укажите причину отклонения заявки:", reply_markup=reason_keyboard)
    await callback.answer()

@dp.callback_query(lambda c: c.data.startswith("reason_"))
async def process_reject_reason(callback: CallbackQuery):
    parts = callback.data.split("_")
    reason = parts[1]
    booking_id = int(parts[2])

    client_id = reject_booking_db(booking_id, reason)

    if reason == "plans":
        master_text = "❌ Запись отклонена (изменились планы). Слот закрыт."
        model_text = "К сожалению, мастер отменил вашу запись, так как у него изменились планы. 😢"
    else:
        master_text = "❌ Запись отклонена (модель не подходит). Слот снова свободен."
        model_text = "К сожалению, мастер отклонил вашу заявку на бронирование. 😢"

    await callback.message.edit_text(master_text)
    await callback.answer()

    if client_id:
        try:
            await bot.send_message(chat_id=client_id, text=model_text)
        except Exception:
            pass

# --- FSM СОСТОЯНИЯ МАСТЕРА ---
class SlotCreate(StatesGroup):
    service_id = State()
    date_time = State()
    confirm = State()

@dp.message(Command("add_slot"))
async def cmd_add_slot(message: Message, state: FSMContext):
    master_id = message.from_user.id
    if not check_is_master(master_id):
        await message.answer("Эта команда доступна только мастерам. 🛑")
        return
            
    services = get_all_services()
    keyboard_buttons = [[InlineKeyboardButton(text=s['name'], callback_data=f"addslot_srv_{s['service_id']}")] for s in services]
    keyboard = InlineKeyboardMarkup(inline_keyboard=keyboard_buttons)
    
    await message.answer("Выберите услугу, для которой хотите создать слот:", reply_markup=keyboard)
    await state.set_state(SlotCreate.service_id)

@dp.callback_query(SlotCreate.service_id, lambda c: c.data.startswith("addslot_srv_"))
async def process_slot_service(callback: CallbackQuery, state: FSMContext):
    service_id = int(callback.data.split("_")[2])
    await state.update_data(service_id=service_id)
    
    await callback.message.edit_text(
        "Отлично! Теперь введите дату и время для слота в формате:\n"
        "**ДД.ММ.ГГГГ ЧЧ:ММ**\n"
        "Например: 30.08.2026 14:00"
    )
    await state.set_state(SlotCreate.date_time)
    await callback.answer()

@dp.message(SlotCreate.date_time)
async def process_slot_datetime(message: Message, state: FSMContext):
    try:
        dt = datetime.strptime(message.text.strip(), "%d.%m.%Y %H:%M")
    except ValueError:
        await message.answer("Неверный формат! 😢 Попробуйте еще раз в формате ДД.ММ.ГГГГ ЧЧ:ММ")
        return
        
    await state.update_data(date_time=dt.isoformat())
    
    keyboard = InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(text="✅ Опубликовать", callback_data="publish_slot")],
        [InlineKeyboardButton(text="❌ Отмена", callback_data="cancel_slot")]
    ])
    
    await message.answer(f"Вы указали время: {dt.strftime('%d.%m.%Y %H:%M')}.\nГотовы опубликовать?", reply_markup=keyboard)
    await state.set_state(SlotCreate.confirm)

@dp.callback_query(SlotCreate.confirm, lambda c: c.data == "publish_slot")
async def publish_slot(callback: CallbackQuery, state: FSMContext):
    data = await state.get_data()
    service_id = data['service_id']
    dt_str = data['date_time']
    master_id = callback.from_user.id
    
    success = add_new_slot(master_id, service_id, dt_str)
        
    if not success:
        await callback.message.edit_text("🛑 У вас уже есть слот на это время! Введите другие дату и время:")
        await state.set_state(SlotCreate.date_time)
        await callback.answer()
        return
        
    await callback.message.edit_text("✅ Слот опубликован! Теперь клиенты смогут на него записаться.")
    await state.clear()
    await callback.answer()

@dp.callback_query(SlotCreate.confirm, lambda c: c.data == "cancel_slot")
async def cancel_slot(callback: CallbackQuery, state: FSMContext):
    await callback.message.edit_text("Создание слота отменено.")
    await state.clear()
    await callback.answer()

# --- ЗАПУСК БОТА ---
async def main():
    print("Бот успешно запущен и готов к работе! 🚀")
    await dp.start_polling(bot)

if __name__ == '__main__':
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\nБот остановлен.")