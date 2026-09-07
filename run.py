import asyncio
import os
import socket
import asyncpg
from datetime import datetime # Добавили
from aiogram import Bot, Dispatcher
from aiogram.filters import CommandStart, Command
from aiogram.types import Message, InlineKeyboardMarkup, InlineKeyboardButton, CallbackQuery
from aiogram.fsm.context import FSMContext # Добавили
from aiogram.fsm.state import State, StatesGroup # Добавили
from dotenv import load_dotenv
from aiogram.types.web_app_info import WebAppInfo

# --- ГЛОБАЛЬНЫЙ ХАК ДЛЯ VPN НА MACOS (только для IPv4) ---
old_getaddrinfo = socket.getaddrinfo
def new_getaddrinfo(*args, **kwargs):
    if args and "supabase.co" in str(args[0]):
        return old_getaddrinfo(*args, **kwargs)
    responses = old_getaddrinfo(*args, **kwargs)
    return [res for res in responses if res[0] == socket.AF_INET]
socket.getaddrinfo = new_getaddrinfo
# ---------------------------------------

load_dotenv()
TOKEN = os.getenv('BOT_TOKEN')
DATABASE_URL = os.getenv('DATABASE_URL')

bot = Bot(token=TOKEN)
dp = Dispatcher()

db_pool = None

@dp.message(CommandStart())
async def command_start_handler(message: Message):
    user_id = message.from_user.id
    full_name = message.from_user.full_name

    async with db_pool.acquire() as connection:
        await connection.execute(
            """
            INSERT INTO Users (user_id, name) 
            VALUES ($1, $2) 
            ON CONFLICT (user_id) DO NOTHING;
            """,
            user_id, full_name
        )

    await message.answer(f"Привет, {full_name}! Твои данные успешно записаны в базу данных Supabase 🚀")


@dp.message(Command("book"))
async def show_available_services(message: Message):
    user_id = message.from_user.id # Получаем ID пользователя

    async with db_pool.acquire() as connection:
        # Ищем услуги, исключая те слоты, где этой модели уже отказали
        rows = await connection.fetch(
            """
            SELECT DISTINCT s.service_id, s.name 
            FROM Services s
            JOIN Slots sl ON s.service_id = sl.service_id
            WHERE sl.status = 'Свободен'
              AND sl.slot_id NOT IN (
                  SELECT slot_id FROM Bookings 
                  WHERE user_id = $1 AND status = 'Отменена мастером'
              );
            """,
            user_id
        )

    if not rows:
        await message.answer("К сожалению, сейчас нет доступных окошек для записи. Загляните позже! ✨")
        return

    keyboard_buttons = []
    for row in rows:
        keyboard_buttons.append([
            InlineKeyboardButton(text=row['name'], callback_data=f"service_{row['service_id']}")
        ])
    
    keyboard = InlineKeyboardMarkup(inline_keyboard=keyboard_buttons)

    await message.answer(
        "Выберите услугу, на которую хотите записаться:",
        reply_markup=keyboard
    )

# --- КОМАНДА ДЛЯ ОТКРЫТИЯ MINI APP ---
@dp.message(Command("app"))
async def cmd_app(message: Message):
    # ВАЖНО: замени ссылку ниже на ту, что скопировала из Netlify!
    web_app_url = "https://rococo-brioche-54517d.netlify.app"
    
    keyboard = InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(text="📱 Открыть приложение", web_app=WebAppInfo(url=web_app_url))]
    ])
    
    await message.answer("Давай протестируем наш интерфейс!", reply_markup=keyboard)

# --- ОБРАБОТЧИК КЛИКА ПО УСЛУГЕ ---
@dp.callback_query(lambda c: c.data.startswith("service_"))
async def process_service_selection(callback: CallbackQuery):
    service_id = int(callback.data.split("_")[1])
    user_id = callback.from_user.id # Получаем ID пользователя

    async with db_pool.acquire() as connection:
        # Ищем слоты, исключая те, где модели отказали
        slots = await connection.fetch(
            """
            SELECT slot_id, date_time 
            FROM Slots 
            WHERE service_id = $1 
              AND status = 'Свободен'
              AND slot_id NOT IN (
                  SELECT slot_id FROM Bookings 
                  WHERE user_id = $2 AND status = 'Отменена мастером'
              );
            """,
            service_id, user_id
        )

    if not slots:
        await callback.message.answer("К сожалению, на эту услугу пока нет свободных окошек.")
        await callback.answer()
        return

    keyboard_buttons = []
    for slot in slots:
        formatted_time = slot['date_time'].strftime("%d.%m.%Y %H:%M")
        keyboard_buttons.append([
            InlineKeyboardButton(text=formatted_time, callback_data=f"slot_{slot['slot_id']}")
        ])

    keyboard = InlineKeyboardMarkup(inline_keyboard=keyboard_buttons)

    await callback.message.edit_text(
        "Выберите удобное время для записи:",
        reply_markup=keyboard
    )
    await callback.answer()


# --- 1. ОБРАБОТЧИК КЛИКА ПО ВРЕМЕНИ (МОДЕЛЬ ЗАПРАШИВАЕТ БРОНЬ) ---
@dp.callback_query(lambda c: c.data.startswith("slot_"))
async def process_slot_booking(callback: CallbackQuery):
    slot_id = int(callback.data.split("_")[1])
    user_id = callback.from_user.id
    full_name = callback.from_user.full_name

    async with db_pool.acquire() as connection:
        async with connection.transaction():
            slot = await connection.fetchrow(
                "SELECT service_id, master_id, status, date_time FROM Slots WHERE slot_id = $1",
                slot_id
            )

            if not slot or slot['status'] != 'Свободен':
                await callback.message.edit_text("К сожалению, этот слот уже занят или ожидает подтверждения! 😢")
                await callback.answer()
                return

            # ИСПРАВЛЕННЫЙ ЗАПРОС: убрали master_id и service_id, как в твоей ER-диаграмме
            booking_id = await connection.fetchval(
                """
                INSERT INTO Bookings (user_id, slot_id, status)
                VALUES ($1, $2, 'Ожидает подтверждения мастера')
                RETURNING booking_id
                """,
                user_id, slot_id
            )

            await connection.execute(
                "UPDATE Slots SET status = 'Ожидает подтверждения' WHERE slot_id = $1",
                slot_id
            )

            service_name = await connection.fetchval(
                "SELECT name FROM Services WHERE service_id = $1", slot['service_id']
            )

    formatted_time = slot['date_time'].strftime('%d.%m.%Y %H:%M')
    await callback.message.edit_text(
        f"Заявка на {service_name} ({formatted_time}) отправлена!\n"
        "Ожидайте подтверждения от мастера ✨"
    )
    await callback.answer()

    master_keyboard = InlineKeyboardMarkup(inline_keyboard=[
        [
            InlineKeyboardButton(text="✅ Подтвердить", callback_data=f"confirm_{booking_id}"),
            InlineKeyboardButton(text="❌ Отклонить", callback_data=f"reject_{booking_id}")
        ]
    ])

    try:
        await bot.send_message(
            chat_id=slot['master_id'],
            text=f"🔔 Новая заявка на бронирование!\n\n"
                 f"👤 Модель: {full_name}\n"
                 f"💅 Услуга: {service_name}\n"
                 f"📅 Время: {formatted_time}\n\n"
                 f"Подтверждаете запись?",
            reply_markup=master_keyboard
        )
    except Exception as e:
        print(f"Не удалось отправить сообщение мастеру: {e}")


# --- 2. ОБРАБОТЧИК: МАСТЕР ПОДТВЕРЖДАЕТ БРОНЬ ---
@dp.callback_query(lambda c: c.data.startswith("confirm_"))
async def confirm_booking(callback: CallbackQuery):
    booking_id = int(callback.data.split("_")[1])

    async with db_pool.acquire() as connection:
        async with connection.transaction():
            booking = await connection.fetchrow(
                "SELECT user_id, slot_id FROM Bookings WHERE booking_id = $1", booking_id
            )

            await connection.execute(
                "UPDATE Bookings SET status = 'Активна' WHERE booking_id = $1", booking_id
            )
            await connection.execute(
                "UPDATE Slots SET status = 'Занят' WHERE slot_id = $1", booking['slot_id']
            )

    await callback.message.edit_text("✅ Вы успешно подтвердили запись! Модели отправлено уведомление.")
    await callback.answer()

    await bot.send_message(
        chat_id=booking['user_id'],
        text="✅ Ура! Мастер подтвердил вашу запись. Ждем вас на процедуру! ✨"
    )


# --- 3. ОБРАБОТЧИК: МАСТЕР НАЖИМАЕТ "ОТКЛОНИТЬ" (Спрашиваем причину) ---
@dp.callback_query(lambda c: c.data.startswith("reject_"))
async def ask_reject_reason(callback: CallbackQuery):
    booking_id = int(callback.data.split("_")[1])

    # Создаем клавиатуру с выбором причины
    reason_keyboard = InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(text="Изменились планы", callback_data=f"reason_plans_{booking_id}")],
        [InlineKeyboardButton(text="Модель не подходит", callback_data=f"reason_model_{booking_id}")]
    ])

    await callback.message.edit_text(
        "Укажите причину отклонения заявки:",
        reply_markup=reason_keyboard
    )
    await callback.answer()


# --- 4. ОБРАБОТЧИК: МАСТЕР ВЫБРАЛ ПРИЧИНУ ОТКЛОНЕНИЯ ---
@dp.callback_query(lambda c: c.data.startswith("reason_"))
async def process_reject_reason(callback: CallbackQuery):
    # Разбиваем callback_data, например "reason_plans_15" -> ["reason", "plans", "15"]
    parts = callback.data.split("_")
    reason = parts[1]
    booking_id = int(parts[2])

    async with db_pool.acquire() as connection:
        async with connection.transaction():
            booking = await connection.fetchrow(
                "SELECT user_id, slot_id FROM Bookings WHERE booking_id = $1", booking_id
            )

            # Бронь в любом случае получает статус 'Отменена мастером'
            await connection.execute(
                "UPDATE Bookings SET status = 'Отменена мастером' WHERE booking_id = $1", booking_id
            )

            if reason == "plans":
                # Слот сгорает, так как мастер не может принять клиента
                await connection.execute(
                    "UPDATE Slots SET status = 'Отменен' WHERE slot_id = $1", booking['slot_id']
                )
                master_text = "❌ Запись отклонена (изменились планы). Слот закрыт."
                model_text = "К сожалению, мастер отменил вашу запись, так как у него изменились планы. 😢"
            
            elif reason == "model":
                # Слот снова доступен для других
                await connection.execute(
                    "UPDATE Slots SET status = 'Свободен' WHERE slot_id = $1", booking['slot_id']
                )
                master_text = "❌ Запись отклонена (модель не подходит). Слот снова свободен."
                model_text = "К сожалению, мастер отклонил вашу заявку на бронирование. 😢"
                # TODO: Здесь в будущем добавим ограничение на повторную запись для этой модели

    await callback.message.edit_text(master_text)
    await callback.answer()

    # Отправляем уведомление модели
    try:
        await bot.send_message(chat_id=booking['user_id'], text=model_text)
    except Exception as e:
        print(f"Не удалось отправить уведомление модели: {e}")

# --- СОСТОЯНИЯ ДЛЯ СОЗДАНИЯ СЛОТА ---
class SlotCreate(StatesGroup):
    service_id = State()
    date_time = State()
    confirm = State()

# --- 1. КОМАНДА /add_slot (МАСТЕР ХОЧЕТ СОЗДАТЬ СЛОТ) ---
@dp.message(Command("add_slot"))
async def cmd_add_slot(message: Message, state: FSMContext):
    master_id = message.from_user.id
    
    async with db_pool.acquire() as connection:
        # Проверяем, есть ли этот пользователь в таблице мастеров
        master = await connection.fetchrow("SELECT master_id FROM Masters WHERE master_id = $1", master_id)
        if not master:
            await message.answer("Эта команда доступна только мастерам. 🛑")
            return
            
        # Достаем все услуги для выбора
        services = await connection.fetch("SELECT service_id, name FROM Services")
        
    keyboard_buttons = []
    for s in services:
        keyboard_buttons.append([InlineKeyboardButton(text=s['name'], callback_data=f"addslot_srv_{s['service_id']}")])
    
    keyboard = InlineKeyboardMarkup(inline_keyboard=keyboard_buttons)
    await message.answer("Выберите услугу, для которой хотите создать слот:", reply_markup=keyboard)
    await state.set_state(SlotCreate.service_id)


# --- 2. МАСТЕР ВЫБРАЛ УСЛУГУ ---
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


# --- 3. МАСТЕР ВВЕЛ ДАТУ И ВРЕМЯ ---
@dp.message(SlotCreate.date_time)
async def process_slot_datetime(message: Message, state: FSMContext):
    try:
        # Пытаемся распарсить текст пользователя в объект времени
        dt = datetime.strptime(message.text.strip(), "%d.%m.%Y %H:%M")
    except ValueError:
        await message.answer("Неверный формат! 😢 Попробуйте еще раз в формате ДД.ММ.ГГГГ ЧЧ:ММ (например: 30.08.2026 14:00)")
        return
        
    # Сохраняем дату в память бота (в формате текста ISO)
    await state.update_data(date_time=dt.isoformat())
    
    # Кнопки публикации по схеме
    keyboard = InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(text="✅ Опубликовать", callback_data="publish_slot")],
        [InlineKeyboardButton(text="❌ Отмена", callback_data="cancel_slot")]
    ])
    
    await message.answer(
        f"Вы указали время: {dt.strftime('%d.%m.%Y %H:%M')}.\nГотовы опубликовать?", 
        reply_markup=keyboard
    )
    await state.set_state(SlotCreate.confirm)


# --- 4. МАСТЕР НАЖИМАЕТ ОПУБЛИКОВАТЬ (Проверка на дубли и запись в БД) ---
@dp.callback_query(SlotCreate.confirm, lambda c: c.data == "publish_slot")
async def publish_slot(callback: CallbackQuery, state: FSMContext):
    data = await state.get_data()
    service_id = data['service_id']
    dt = datetime.fromisoformat(data['date_time'])
    master_id = callback.from_user.id
    
    async with db_pool.acquire() as connection:
        # Защита от дублей слотов (по схеме)
        existing_slot = await connection.fetchrow(
            "SELECT slot_id FROM Slots WHERE master_id = $1 AND date_time = $2",
            master_id, dt
        )
        
        if existing_slot:
            await callback.message.edit_text(
                "🛑 Невозможно создать слот на это время — у вас уже есть слот на этот момент!\n\n"
                "Введите другие дату и время (ДД.ММ.ГГГГ ЧЧ:ММ):"
            )
            # Возвращаем мастера на шаг ввода времени
            await state.set_state(SlotCreate.date_time)
            await callback.answer()
            return
            
        # Сохранение слота
        await connection.execute(
            """
            INSERT INTO Slots (date_time, status, master_id, service_id)
            VALUES ($1, 'Свободен', $2, $3)
            """,
            dt, master_id, service_id
        )
        
    await callback.message.edit_text("✅ Слот опубликован! Теперь клиенты смогут на него записаться.")
    await state.clear() # Очищаем состояние
    await callback.answer()


# --- ОТМЕНА СОЗДАНИЯ СЛОТА ---
@dp.callback_query(SlotCreate.confirm, lambda c: c.data == "cancel_slot")
async def cancel_slot(callback: CallbackQuery, state: FSMContext):
    await callback.message.edit_text("Создание слота отменено.")
    await state.clear()
    await callback.answer()


# --- ЗАПУСК БОТА ---
async def main():
    global db_pool
    print("Подключаемся к базе данных...")
    # Добавляем statement_cache_size=0, чтобы подружить asyncpg с портом 6543 (PgBouncer)
    db_pool = await asyncpg.create_pool(
        DATABASE_URL, 
        ssl='require', 
        statement_cache_size=0
    )
    
    print("Бот успешно запущен и готов к работе!")
    try:
        await dp.start_polling(bot)
    finally:
        await db_pool.close()

if __name__ == '__main__':
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\nБот остановлен.")