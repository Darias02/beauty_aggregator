#!/bin/zsh
cd -- "${0:A:h}" || exit 1
if ! command -v python3 >/dev/null; then
  print 'Для запуска нужен Python 3 с python.org. Установите его и откройте этот файл снова.'
  read '?Нажмите Enter для закрытия.'
  exit 1
fi
print 'Beauty Booking: локальные фиктивные данные. Остановить: Ctrl+C или закрыть окно.'
python3 tests/bb75/serve_mock.py --open
if [[ $? -ne 0 ]]; then
  print 'Сервер не запущен. Проверьте ошибку выше. Другие серверы автоматически не открываются.'
  read '?Нажмите Enter для закрытия.'
fi
