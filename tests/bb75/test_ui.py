"""Run: python -m pytest tests/bb75 -q. Uses installed Chrome, never real APIs."""
import threading
import json
import platform
import re
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from urllib.parse import urlparse

import pytest
from playwright.sync_api import sync_playwright, expect
from mock_api import MockAPI, PNG
from serve_mock import Handler

ROOT = Path(__file__).resolve().parents[2]
TG = """window.__tgCalls=[]; window.__popups=[];
window.Telegram={WebApp:{initData:'bb75-invalid-mock-signature',
initDataUnsafe:{user:{id:101,first_name:'Mock',username:'bb75_mock'}},
ready(){__tgCalls.push('ready')},expand(){__tgCalls.push('expand')},
setHeaderColor(){},setBackgroundColor(){},
HapticFeedback:{impactOccurred(s){__tgCalls.push(s)}},
showPopup(p){__popups.push(p.message)},openTelegramLink(u){__tgCalls.push(u)}}};"""


@pytest.fixture(scope='session')
def server(request, tmp_path_factory):
    class Quiet(Handler):
        telegram_script = TG
        def log_message(self, *args):
            pass
    if request.config.getoption('--production-artifact'):
        import importlib.util
        from unittest.mock import patch
        spec = importlib.util.spec_from_file_location('bb76_builder', ROOT / 'scripts/build_production_frontend.py')
        builder = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(builder)
        builder.OUTPUT = tmp_path_factory.mktemp('production') / 'dist'
        with patch.dict('os.environ', {'BB_PRODUCTION_PUBLISHABLE_KEY': 'sb_publishable_bb76_fictional',
                                      'BB_PRODUCTION_MAINTENANCE': 'false', 'VERCEL_ENV': 'production'}):
            builder.build()
        class Quiet(SimpleHTTPRequestHandler):
            def __init__(self, *args, **kwargs):
                super().__init__(*args, directory=str(builder.OUTPUT), **kwargs)
            def log_message(self, *args):
                pass
    http = ThreadingHTTPServer(('127.0.0.1', 0), Quiet)
    thread = threading.Thread(target=http.serve_forever, daemon=True)
    thread.start()
    yield f'http://127.0.0.1:{http.server_port}'
    http.shutdown()


@pytest.fixture
def ui(server, request):
    live_api = getattr(request, 'param', None) == 'http'
    if live_api and request.config.getoption('--production-artifact'):
        pytest.skip('local preview only')
    with sync_playwright() as p:
        browser = p.chromium.launch(channel='chrome', headless=True)
        context = browser.new_context(viewport={'width': 390, 'height': 844},
                                      is_mobile=True, has_touch=True, service_workers='block')
        context.add_init_script(TG)
        context.set_default_timeout(7000)
        artifacts = ROOT / 'tests/bb75/artifacts'
        artifacts.mkdir(exist_ok=True)
        name = re.sub(r'[^a-zA-Z0-9_-]', '_', request.node.name)
        if request.config.getoption('--production-artifact'):
            name = 'production-' + name
        (artifacts / 'environment.json').write_text(json.dumps({
            'chrome': browser.version, 'python': platform.python_version(),
            'platform': platform.platform(), 'telegram': 'mock only',
        }, indent=2))
        context.tracing.start(screenshots=True, snapshots=True, sources=True)
        live_api = getattr(request, "param", None) == "http"
        api = MockAPI()
        if live_api:
            Handler.api = api
        api.held = []
        api.hold = None
        api.uploads = []
        blocked = []
        errors = []
        def route(r):
            u = urlparse(r.request.url)
            if u.netloc in (urlparse(server).netloc, 'bxzwfidujuejmrbqjmgo.supabase.co') and u.path.startswith('/functions/v1/'):
                if live_api:
                    if u.netloc == urlparse(server).netloc:
                        r.continue_()
                    else:
                        blocked.append(r.request.url)
                        r.abort('blockedbyclient')
                    return
                endpoint = u.path.rsplit('/', 1)[-1]
                if api.hold == endpoint:
                    api.held.append(r)
                    return
                failure = api.failures.get(endpoint, api.failure)
                if failure == 'network':
                    r.abort('failed')
                    return
                if failure == 'malformed':
                    r.fulfill(body='{broken', content_type='application/json')
                    return
                if failure:
                    r.fulfill(status=failure, json={'error': {'code': 'UNAUTHORIZED' if failure == 401 else 'INTERNAL'}})
                    return
                if endpoint == 'master-avatar':
                    api.uploads.append(r.request.post_data_buffer)
                body = r.request.post_data_json if 'application/json' in r.request.headers.get('content-type', '') else {}
                r.fulfill(json=api.respond(endpoint, body or {}))
            elif u.netloc == urlparse(server).netloc:
                r.continue_()
            elif request.config.getoption('--production-artifact') and u.hostname in ('telegram.org', 'fonts.googleapis.com', 'fonts.gstatic.com'):
                r.fulfill(status=200, body='', content_type='text/javascript' if u.hostname == 'telegram.org' else 'text/css')
            else:
                blocked.append(r.request.url)
                r.fulfill(status=200, body='', content_type='text/javascript')
        context.route('**/*', route)
        page = context.new_page()
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.goto(server)
        expect(page.locator('#model-menu-services')).to_contain_text('Маникюр')
        try:
            yield page, api
        finally:
            for held in api.held:
                held.abort()
            page.screenshot(path=str(artifacts / f'{name}.png'), full_page=True, animations='disabled')
            context.tracing.stop(path=str(artifacts / f'{name}.zip'))
            context.close()
            browser.close()
            assert not errors, errors
            # No external request is allowed to fall back to the network.
            assert not blocked, blocked


def navigate(page, screen):
    page.evaluate('(s)=>window.navigate(s)', screen)
    expect(page.locator('#' + screen)).to_be_visible()


def master(page):
    page.evaluate("window.switchRole('master')")
    expect(page.locator('#screen-master-menu')).to_be_visible()


def popup(page, text):
    page.wait_for_function('(s)=>__popups.some(p=>p.includes(s))', arg=text)


def test_profiles_and_telegram(ui):
    page, api = ui
    navigate(page, 'screen-model-profile')
    expect(page.locator('#model-profile-name')).to_have_text('Модель mock')
    page.once('dialog', lambda d: d.accept('Новое имя'))
    page.locator('#model-profile-name').click()
    expect(page.locator('#model-profile-name')).to_have_text('Новое имя')
    master(page)
    navigate(page, 'screen-master-profile')
    expect(page.locator('#master-profile-name')).to_have_text('Мастер mock')
    page.locator('#master-address-input').fill('Новый адрес')
    page.locator('#master-address-input').blur()
    expect(page.locator('#master-address-input')).to_have_value('Новый адрес')
    page.locator('#master-avatar-upload').set_input_files({'name': 'avatar.png', 'mimeType': 'image/png', 'buffer': PNG})
    popup(page, 'Фото сохранено')
    assert page.evaluate("__tgCalls.includes('ready') && __tgCalls.includes('expand')")
    assert any(e == 'user-profile' and b.get('action') == 'ensure' for e,b in api.calls)
    assert any(e == 'master-profile' and b.get('action') == 'ensure' for e,b in api.calls)
    assert any(e == 'master-avatar' for e,b in api.calls)
    assert api.master['address'] == 'Новый адрес'
    assert b'filename="avatar.png"' in api.uploads[0]
    assert PNG in api.uploads[0]
    assert b'bb75-invalid-mock-signature' in api.uploads[0]
    assert page.locator('#master-profile-avatar').evaluate("e=>e.style.backgroundImage.includes('data:image/png')")


def test_booking_and_model_cancel(ui):
    page, api = ui
    page.locator('#model-menu-services button').first.click()
    expect(page.locator('#model-search-results')).to_contain_text('Записаться')
    page.locator('#model-search-results button').click()
    expect(page.locator('#screen-model-success')).to_be_visible()
    navigate(page, 'screen-model-records')
    page.get_by_role('button', name='Отменить', exact=True).click()
    page.get_by_role('button', name='Не подходит время', exact=True).click()
    popup(page, 'отмен')
    assert api.bookings[0]['status'] == 'Отменена моделью'
    page.locator('#screen-model-records [data-mode=archive]').click()
    expect(page.locator('#model-records-list')).to_contain_text('Отменена моделью')
    assert any(e == 'notify-master' for e,b in api.calls)


@pytest.mark.parametrize('decision', ['confirm', 'reject', 'cancel'])
def test_master_decisions(ui, decision):
    page, api = ui
    api.pending()
    master(page)
    navigate(page, 'screen-master-records')
    if decision == 'confirm':
        page.get_by_role('button', name='Подтвердить', exact=True).click()
        popup(page, 'подтверждена')
        assert api.bookings[0]['status'] == 'Активна'
    else:
        page.get_by_role('button', name='Отклонить' if decision == 'reject' else 'Отменить слот', exact=True).click()
        page.get_by_role('button', name='Не подходит модель' if decision == 'reject' else 'Изменились планы', exact=True).click()
        popup(page, 'обработана' if decision == 'reject' else 'отменён')
        assert api.bookings[0]['status'] == 'Отменена мастером'


@pytest.mark.parametrize('failure', ['network', 401, 500])
def test_api_errors(ui, failure):
    page, api = ui
    api.failure = failure
    navigate(page, 'screen-model-menu')
    expect(page.locator('#model-menu-services')).to_contain_text('Не удалось загрузить услуги')
    navigate(page, 'screen-model-profile')
    expect(page.locator('#model-profile-name')).to_contain_text('Авторизация' if failure == 401 else 'Не удалось')


def test_empty_slots_and_modal_escape(ui):
    page, api = ui
    api.slots = []
    page.locator('#model-menu-services button').first.click()
    expect(page.locator('#model-search-results')).to_contain_text('Свободных слотов пока нет')
    api.slots = [__import__('copy').deepcopy(__import__('mock_api').SLOT)]
    api.pending()
    master(page)
    navigate(page, 'screen-master-records')
    page.get_by_role('button', name='Отклонить', exact=True).click()
    expect(page.locator('.modal-overlay.active')).to_be_visible()
    page.keyboard.press('Escape')
    expect(page.locator('.modal-overlay')).to_have_count(0)
    assert api.bookings[0]['status'] == 'Ожидает подтверждения мастера'


@pytest.mark.parametrize('width,height', [(320,568), (360,640), (390,844), (430,932)])
def test_mobile_layout(ui, width, height):
    page, api = ui
    page.set_viewport_size({'width': width, 'height': height})
    for role in ('model', 'master'):
        if role == 'master':
            master(page)
        for suffix in ('menu', 'profile', 'records'):
            navigate(page, f'screen-{role}-{suffix}')
            page.wait_for_timeout(350)
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), (role,suffix,width)
    navigate(page, 'screen-master-add')
    page.get_by_role('button', name='Опубликовать слот', exact=True).scroll_into_view_if_needed()
    expect(page.get_by_role('button', name='Опубликовать слот', exact=True)).to_be_in_viewport()
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), page.evaluate("[...document.querySelectorAll('.screen.active *')].filter(e=>e.getBoundingClientRect().right>innerWidth).map(e=>({tag:e.tagName,cls:e.className,width:e.getBoundingClientRect().width,right:e.getBoundingClientRect().right}))")


def test_booking_double_click(ui):
    page, api = ui
    page.locator('#model-menu-services button').first.click()
    button = page.locator('#model-search-results button')
    expect(button).to_be_visible()
    button.evaluate('(b)=>{b.click();b.click()}')
    expect(page.locator('#screen-model-success')).to_be_visible()
    assert sum(e == 'booking-create' for e,b in api.calls) == 1


def test_confirm_double_click(ui):
    page, api = ui
    api.pending()
    master(page)
    navigate(page, 'screen-master-records')
    button = page.get_by_role('button', name='Подтвердить', exact=True)
    expect(button).to_be_visible()
    button.evaluate('(b)=>{b.click();b.click()}')
    popup(page, 'подтверждена')
    assert sum(e == 'bookings-write' for e,b in api.calls) == 1


def test_schedule_and_publication(ui):
    page, api = ui
    master(page)
    page.get_by_role('button', name='Создать новый слот', exact=True).click()
    expect(page.locator('#screen-master-add')).to_be_visible()
    page.get_by_role('button', name='Опубликовать слот', exact=True).click()
    popup(page, 'Выберите')
    page.locator('#selected-service').click()
    page.locator('#service-dropdown .dropdown-item').first.click()
    page.locator('#slot-city-input').fill('Москва')
    page.locator('#slot-address-input').fill('Адрес mock')
    page.locator('#slot-time-input').fill('23:59')
    page.locator('.calendar-day:not([style])').last.click()
    page.get_by_role('button', name='Опубликовать слот', exact=True).click()
    expect(page.locator('#screen-master-success')).to_be_visible()
    assert any(e == 'slots-write' and b['action'] == 'create' for e,b in api.calls)


def test_invalid_avatar_and_api_failure(ui):
    page, api = ui
    master(page)
    navigate(page, 'screen-master-profile')
    upload = page.locator('#master-avatar-upload')
    upload.set_input_files({'name':'bad.txt','mimeType':'text/plain','buffer':b'bad'})
    popup(page, 'Выберите изображение')
    assert not any(e == 'master-avatar' for e,b in api.calls)
    api.failure = 500
    upload.set_input_files({'name':'test.png','mimeType':'image/png','buffer':PNG})
    popup(page, 'Не удалось сохранить фото')


def test_booking_error_retry(ui):
    page, api = ui
    page.locator('#model-menu-services button').first.click()
    expect(page.locator('#model-search-results button')).to_be_visible()
    api.failures['booking-create'] = 500
    page.locator('#model-search-results button').click()
    popup(page, 'Не удалось отправить заявку')
    expect(page.locator('#model-search-results button')).to_be_enabled()
    api.failures.clear()
    page.locator('#model-search-results button').click()
    expect(page.locator('#screen-model-success')).to_be_visible()


def test_catalog_loading_and_empty(ui):
    page, api = ui
    api.hold = 'catalog'
    navigate(page, 'screen-model-menu')
    expect(page.locator('#model-menu-services')).to_contain_text('Загружаем услуги')
    api.hold = None
    api.services = []
    for held in api.held:
        held.fulfill(json={'services': []})
    api.held.clear()
    expect(page.locator('#model-menu-services')).to_contain_text('Услуг пока нет')


def test_master_profile_error(ui):
    page, api = ui
    master(page)
    api.failure = 500
    navigate(page, 'screen-master-profile')
    expect(page.locator('#master-profile-name')).to_contain_text('Не удалось')


def test_long_catalog_and_success_mobile(ui):
    page, api = ui
    page.set_viewport_size({'width':320,'height':568})
    api.services[0]['name'] = 'ОченьДлинноеНазвание' * 10
    api.slots[0]['services']['name'] = api.services[0]['name']
    navigate(page, 'screen-model-menu')
    expect(page.locator('#model-menu-services .service-title')).to_contain_text('ОченьДлинноеНазвание')
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
    page.locator('#model-menu-services button').click()
    expect(page.locator('#model-search-results button')).to_be_visible()
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
    page.locator('#model-search-results button').click()
    expect(page.locator('#screen-model-success')).to_be_visible()
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')


def test_publication_double_click(ui):
    page, api = ui
    master(page)
    navigate(page, 'screen-master-add')
    page.locator('#selected-service').click()
    page.locator('#service-dropdown .dropdown-item').first.click()
    page.locator('#slot-city-input').fill('Москва')
    page.locator('#slot-time-input').fill('23:59')
    page.locator('.calendar-day:not([style])').last.click()
    page.get_by_role('button', name='Опубликовать слот').evaluate('(b)=>{b.click();b.click()}')
    expect(page.locator('#screen-master-success')).to_be_visible()
    assert sum(e == 'slots-write' for e,b in api.calls) == 1


def test_modal_double_click(ui):
    page, api = ui
    api.pending()
    master(page)
    navigate(page, 'screen-master-records')
    page.get_by_role('button', name='Отклонить', exact=True).click()
    page.get_by_role('button', name='Не подходит модель', exact=True).evaluate('(b)=>{b.click();b.click()}')
    popup(page, 'обработана')
    assert sum(e == 'bookings-write' for e,b in api.calls) == 1


def test_narrow_modal_and_navigation(ui):
    page, api = ui
    page.set_viewport_size({'width':320,'height':400})
    nav = page.locator('#bottom-navigation')
    box = nav.bounding_box()
    assert box['x'] >= 0 and box['x'] + box['width'] <= 320, box
    api.pending()
    master(page)
    navigate(page, 'screen-master-records')
    page.get_by_role('button', name='Отклонить', exact=True).click()
    modal = page.locator('.modal-overlay.active .modal-box')
    expect(modal).to_be_visible()
    box = modal.bounding_box()
    assert box['x'] >= 0 and box['x'] + box['width'] <= 320, box


def test_visible_navigation_after_resize(ui):
    page, api = ui
    page.set_viewport_size({'width':320,'height':568})
    page.locator('#bottom-navigation .nav-item').filter(has_text='Профиль').click()
    expect(page.locator('#screen-model-profile')).to_be_visible()
    page.wait_for_timeout(350)
    indicator = page.locator('#nav-indicator').bounding_box()
    nav = page.locator('#bottom-navigation').bounding_box()
    assert indicator['x'] + indicator['width'] <= nav['x'] + nav['width'] + 1, (indicator, nav)
    page.locator("#screen-model-profile [onclick*=switchRole]").click()
    expect(page.locator('#screen-master-menu')).to_be_visible()
    assert page.locator('#bottom-navigation .nav-item').count() == 3


def test_modal_does_not_scroll_background(ui):
    import copy
    page, api = ui
    api.pending()
    api.slots.extend({**copy.deepcopy(api.slots[0]), 'slot_id': 100+i} for i in range(20))
    master(page)
    navigate(page, 'screen-master-records')
    page.get_by_role('button', name='Отклонить', exact=True).first.click()
    expect(page.locator('.modal-overlay.active')).to_be_visible()
    before = page.evaluate('scrollY')
    page.mouse.move(5, 400)
    page.mouse.wheel(0, 700)
    page.wait_for_timeout(350)
    assert page.evaluate('scrollY') == before


def test_free_slot_delete_and_empty(ui):
    page, api = ui
    master(page)
    navigate(page, 'screen-master-records')
    page.get_by_role('button', name='Удалить слот', exact=True).click()
    page.get_by_role('button', name='Удалить', exact=True).click()
    popup(page, 'Слот удалён')
    expect(page.locator('#master-records-list')).to_contain_text('Активных слотов пока нет')
    assert api.slots == []


def test_oversized_avatar(ui):
    page, api = ui
    master(page)
    navigate(page, 'screen-master-profile')
    page.locator('#master-avatar-upload').set_input_files({
        'name':'large.png', 'mimeType':'image/png', 'buffer':b'x'*(5*1024*1024+1)})
    popup(page, '5 МиБ')
    assert not any(e == 'master-avatar' for e,b in api.calls)


def test_no_telegram_identity(ui):
    page, api = ui
    page.evaluate('window.Telegram = undefined')
    navigate(page, 'screen-model-profile')
    expect(page.locator('#model-profile-name')).to_contain_text('Авторизация')
    alerts = []
    page.on('dialog', lambda d: (alerts.append(d.message), d.accept()))
    page.locator("#screen-model-profile [onclick*=switchRole]").click()
    expect(page.locator('#screen-model-profile')).to_be_visible()
    assert alerts == ['Откройте приложение через Telegram.']


def test_mock_support_link(ui):
    page, api = ui
    navigate(page, 'screen-model-profile')
    page.locator('#screen-model-profile .support-button').click()
    assert page.evaluate("__tgCalls.includes('https://t.me/darghff')")


def test_mock_server_safety(server, request):
    from urllib.request import urlopen
    if request.config.getoption('--production-artifact'):
        with urlopen(server + '/release.json') as response:
            release = json.load(response)
        assert release['maintenance'] is False
        with urlopen(server) as response:
            html = response.read().decode()
        assert f"releases/{release['release']}/js/boot.js" in html
        assert 'cdn.jsdelivr.net' not in html
        with urlopen(server + f"/releases/{release['release']}/js/config.js") as response:
            config = response.read().decode()
        assert 'sb_publishable_bb76_fictional' in config
        assert 'sb_secret_' not in config
        return
    with urlopen(server) as response:
        html = response.read().decode()
        assert 'https://telegram.org/js/' not in html
        assert 'https://cdn.jsdelivr.net/' not in html
        assert 'https://fonts.googleapis.com/' not in html
        assert "connect-src 'self'" in response.headers['Content-Security-Policy']
    with urlopen(server + '/js/config.js') as response:
        config = response.read().decode()
        assert 'supabase.co' not in config
        assert 'sb_publishable_' not in config
        assert "key: 'bb75-mock-only'" in config


def test_city_filter_and_slots_network_error(ui):
    page, api = ui
    page.locator('#model-menu-services button').first.click()
    page.locator('.city-filter').click()
    page.locator('#city-dropdown .dropdown-item').filter(has_text='Москва').click()
    expect(page.locator('#model-search-results button')).to_be_visible()
    assert any(e == 'slots-read' and b.get('city') == 'Москва' for e,b in api.calls)
    api.failures['slots-read'] = 'network'
    page.locator('.city-filter').click()
    page.locator('#city-dropdown .dropdown-item').filter(has_text='Все города').click()
    expect(page.locator('#model-search-results')).to_contain_text('Не удалось загрузить свободные слоты')


def test_malformed_booking_response(ui):
    page, api = ui
    page.locator('#model-menu-services button').first.click()
    expect(page.locator('#model-search-results button')).to_be_visible()
    api.failures['booking-create'] = 'malformed'
    page.locator('#model-search-results button').click()
    popup(page, 'Не удалось отправить заявку')
    expect(page.locator('#model-search-results button')).to_be_enabled()


def test_records_api_failure(ui):
    page, api = ui
    api.failures['bookings-read'] = 500
    navigate(page, 'screen-model-records')
    expect(page.locator('#model-records-list')).to_contain_text('Не удалось загрузить записи')
    api.failures['slots-read'] = 500
    master(page)
    navigate(page, 'screen-master-records')
    expect(page.locator('#master-records-list')).to_contain_text('Не удалось загрузить слоты')


def test_production_gate_blocks_before_api(ui, request):
    if not request.config.getoption('--production-artifact'):
        pytest.skip('production release gate only')
    page, _ = ui
    sent = []
    page.route('**/release.json', lambda route: route.fulfill(
        json={'release': 'changed', 'maintenance': True}))
    def unexpected(route):
        sent.append(route.request.url)
        route.fulfill(json={})
    page.route('**/functions/v1/**', unexpected)
    result = page.evaluate("""async () => {
        try {
            await fetch('https://bxzwfidujuejmrbqjmgo.supabase.co/functions/v1/bookings-write',
                {method:'POST', body:JSON.stringify({init_data:'fictional'})});
            return 'sent';
        } catch (error) { return error.message; }
    }""")
    assert 'APP_UPDATE_REQUIRED' in result
    expect(page.get_by_role('alert')).to_be_visible()
    assert sent == []


@pytest.mark.parametrize('ui', ['http'], indirect=True)
def test_http_preview_full_flow(ui, request):
    if request.config.getoption('--production-artifact'):
        pytest.skip('local preview only')
    # Exercise the actual Python API; Playwright does not fulfill these requests.
    page, api = ui
    master(page)
    page.get_by_role('button', name='Создать новый слот', exact=True).click()
    page.locator('#selected-service').click()
    page.locator('#service-dropdown .dropdown-item').first.click()
    page.locator('#slot-city-input').fill('Москва')
    page.locator('#slot-address-input').fill('Второй адрес')
    page.locator('#slot-time-input').fill('23:59')
    page.locator('.calendar-day:not([style])').last.click()
    page.get_by_role('button', name='Опубликовать слот', exact=True).click()
    expect(page.locator('#screen-master-success')).to_be_visible()
    assert len({s['slot_id'] for s in api.slots}) == 2
    page.evaluate("window.switchRole('model')")
    page.locator('#model-menu-services button').first.click()
    expect(page.locator('#model-search-results button')).to_have_count(2)
    page.locator('#model-search-results button').last.click()
    expect(page.locator('#screen-model-success')).to_be_visible()
    expect(page.locator('#succ-val-address')).to_have_text('Второй адрес')
    master(page)
    navigate(page, 'screen-master-records')
    page.get_by_role('button', name='Подтвердить', exact=True).click()
    popup(page, 'подтверждена')
    page.evaluate("window.switchRole('model')")
    navigate(page, 'screen-model-records')
    page.get_by_role('button', name='Отменить', exact=True).click()
    page.get_by_role('button', name='Не подходит время', exact=True).click()
    popup(page, 'отмен')
    page.locator('#screen-model-records [data-mode=archive]').click()
    expect(page.locator('#model-records-list')).to_contain_text('Отменена моделью')
    navigate(page, 'screen-model-search')
    page.locator('#model-search-results button').last.click()
    expect(page.locator('#screen-model-success')).to_be_visible()
    assert len({b['booking_id'] for b in api.bookings}) == 2
    master(page)
    navigate(page, 'screen-master-records')
    page.get_by_role('button', name='Отменить слот', exact=True).click()
    page.get_by_role('button', name='Изменились планы', exact=True).click()
    popup(page, 'отменён')
    assert api.bookings[-1]['status'] == 'Отменена мастером'
    page.get_by_role('button', name='Удалить слот', exact=True).first.click()
    page.get_by_role('button', name='Удалить', exact=True).click()
    popup(page, 'Слот удалён')
    assert len(api.slots) == 1
    assert api.slots[0]['address'] == 'Второй адрес'
    # The preview's JavaScript guard rejects even an explicit external API URL.
    assert page.evaluate("async () => {try {await fetch('https://api.telegram.org/'); return false;} catch(e) {return e.message;}}") == 'LOCAL_ONLY'


def test_local_config_fails_closed():
    from unittest.mock import patch
    from serve_mock import local_config
    with patch('pathlib.Path.read_text', return_value='export const APP_CONFIG = {};'):
        with pytest.raises(RuntimeError, match='no production fallback'):
            local_config()


def test_preview_config_aliases(server, request):
    from urllib.request import urlopen
    from urllib.error import HTTPError
    if request.config.getoption('--production-artifact'):
        pytest.skip('local preview only')
    for path in ('/js/config.js?v=1', '/js/%63onfig.js'):
        with urlopen(server + path) as response:
            config = response.read().decode()
            assert 'supabase.co' not in config
            assert 'bb75-mock-only' in config
            assert "connect-src 'self'" in response.headers['Content-Security-Policy']
    for path in ('/js/', '/%2e%2e/.env', '/js/../js/config.js'):
        with pytest.raises(HTTPError) as error:
            urlopen(server + path)
        assert error.value.code == 404
