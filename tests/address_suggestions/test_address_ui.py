"""Offline Chrome checks. No DaData credentials, production requests or schema changes."""
import copy
import sys
import threading
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from urllib.parse import urlparse

import pytest
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'tests/bb75'))
from mock_api import MockAPI  # noqa: E402
from serve_mock import Handler  # noqa: E402

CITY_ID = '0c5b2444-70a0-4932-980c-b4dc0d3f02b5'
TG = """window.__popups=[];window.Telegram={WebApp:{
initData:'offline-invalid-signature',initDataUnsafe:{user:{id:101,first_name:'Mock'}},
ready(){},expand(){},setHeaderColor(){},setBackgroundColor(){},HapticFeedback:{impactOccurred(){}},
showPopup(p){__popups.push(p.message)},openTelegramLink(){}}};"""

@pytest.fixture(scope='module')
def server(request, tmp_path_factory):
    class Quiet(Handler):
        telegram_script = TG
        def log_message(self, *args):
            pass
    if request.config.getoption('--address-artifact'):
        import importlib.util
        from unittest.mock import patch
        spec = importlib.util.spec_from_file_location('address_builder', ROOT / 'scripts/build_production_frontend.py')
        builder = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(builder)
        builder.OUTPUT = tmp_path_factory.mktemp('address-artifact') / 'dist'
        with patch.dict('os.environ', {'BB_PRODUCTION_PUBLISHABLE_KEY':'sb_publishable_address_fictional',
                                      'BB_PRODUCTION_MAINTENANCE':'false', 'VERCEL_ENV':'production'}):
            builder.build()
        class Quiet(SimpleHTTPRequestHandler):
            def __init__(self, *args, **kwargs):
                super().__init__(*args, directory=str(builder.OUTPUT), **kwargs)
            def log_message(self, *args):
                pass
    http = ThreadingHTTPServer(('127.0.0.1', 0), Quiet)
    threading.Thread(target=http.serve_forever, daemon=True).start()
    yield f'http://127.0.0.1:{http.server_port}'
    http.shutdown()
    http.server_close()

@pytest.fixture
def ui(server, tmp_path, request):
    with sync_playwright() as p:
        browser = p.chromium.launch(channel='chrome', headless=True)
        context = browser.new_context(viewport={'width':390, 'height':844}, is_mobile=True,
                                      has_touch=True, service_workers='block')
        context.add_init_script(TG)
        context.set_default_timeout(7000)
        api = MockAPI()
        api.suggestion_failure = None
        api.suggestion_empty = False
        api.hold_profile = None
        api.held_profiles = []
        blocked, errors = [], []
        def route(r):
            u = urlparse(r.request.url)
            allowed_api = u.netloc == urlparse(server).netloc or (
                request.config.getoption('--address-artifact') and u.netloc == 'bxzwfidujuejmrbqjmgo.supabase.co')
            if allowed_api and u.path.startswith('/functions/v1/'):
                endpoint = u.path.rsplit('/', 1)[-1]
                body = r.request.post_data_json
                if endpoint == 'address-suggest':
                    api.calls.append((endpoint, body))
                    if api.suggestion_failure == 'network':
                        r.abort('failed')
                    elif api.suggestion_failure:
                        r.fulfill(status=api.suggestion_failure, json={'error':{'code':'SUGGESTIONS_UNAVAILABLE'}})
                    else:
                        items = [] if api.suggestion_empty else [
                            {'label':'г Москва' if body['mode']=='city' else 'г Москва, ул Тверская, д 1',
                             'value':'Москва' if body['mode']=='city' else 'г Москва, ул Тверская, д 1',
                             'cityId':CITY_ID},
                            {'label':'Московская обл, г Зеленоград', 'value':'Зеленоград', 'cityId':None},
                        ]
                        r.fulfill(json={'suggestions':items})
                else:
                    if endpoint == 'master-profile' and api.hold_profile and api.hold_profile(body):
                        api.held_profiles.append(r)
                        return
                    r.fulfill(json=api.respond(endpoint, body))
            elif u.netloc == urlparse(server).netloc:
                r.continue_()
            elif request.config.getoption('--address-artifact') and u.hostname in ('telegram.org', 'fonts.googleapis.com', 'fonts.gstatic.com'):
                r.fulfill(status=200, body='', content_type='text/javascript' if u.hostname=='telegram.org' else 'text/css')
            else:
                blocked.append(r.request.url)
                r.abort()
        context.route('**/*', route)
        page = context.new_page()
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.goto(server)
        expect(page.locator('#model-menu-services')).to_contain_text('Маникюр')
        page.evaluate("window.switchRole('master')")
        expect(page.locator('#screen-master-menu')).to_be_visible()
        yield page, api
        page.screenshot(path=str(tmp_path / 'final.png'), full_page=True)
        browser.close()
        assert not blocked, blocked
        assert not errors, errors


def navigate(page, screen):
    page.evaluate('(screen)=>window.navigate(screen)', screen)
    expect(page.locator('#'+screen)).to_be_visible()


def slot_form(page):
    navigate(page, 'screen-master-add')
    page.locator('#selected-service').click()
    page.locator('#service-dropdown .dropdown-item').first.click()
    page.locator('#slot-time-input').fill('23:59')
    page.locator('.calendar-day:not([style])').last.click()


def test_selection_save_reopen_and_client_display(ui):
    page, api = ui
    original = copy.deepcopy(api.slots)
    navigate(page, 'screen-master-profile')
    field = page.locator('#master-address-input')
    field.fill('Москва Тверская')
    option = page.locator('#master-address-input-suggestions [role=option]').first
    expect(option).to_be_visible()
    with page.expect_response(lambda response: response.url.endswith('/functions/v1/master-profile')
                              and response.request.post_data_json.get('profile', {}).get('address') == 'г Москва, ул Тверская, д 1'):
        option.tap()
    expect(field).to_have_value('г Москва, ул Тверская, д 1')
    page.wait_for_function("()=>document.querySelector('#master-address-input').getAttribute('aria-expanded')==='false'")
    navigate(page, 'screen-master-menu')
    navigate(page, 'screen-master-profile')
    expect(field).to_have_value('г Москва, ул Тверская, д 1')
    assert api.master['address'] == 'г Москва, ул Тверская, д 1'
    assert api.slots == original
    updates = [b['profile']['address'] for e,b in api.calls if e=='master-profile' and 'address' in b.get('profile',{})]
    assert updates == ['г Москва, ул Тверская, д 1']
    slot_form(page)
    city = page.locator('#slot-city-input')
    expect(city).to_have_value('')
    page.get_by_role('button', name='Опубликовать слот', exact=True).click()
    page.wait_for_function("()=>__popups.includes('Укажите город.')")
    assert not any(e=='slots-write' for e,b in api.calls)
    city.fill('Мос')
    page.locator('#slot-city-input-suggestions [role=option]').first.tap()
    expect(city).to_have_value('Москва')
    address = page.locator('#slot-address-input')
    address.fill('Тверская')
    page.locator('#slot-address-input-suggestions [role=option]').first.tap()
    selected_address = address.input_value()
    requests = [b for e,b in api.calls if e=='address-suggest' and b['query']=='Тверская']
    assert requests[-1]['city_id'] == CITY_ID
    page.get_by_role('button', name='Опубликовать слот', exact=True).click()
    expect(page.locator('#screen-master-success')).to_be_visible()
    assert api.slots[-1]['city'] == 'Москва'
    assert api.slots[-1]['address'] == selected_address
    assert api.slots[:-1] == original
    # Later profile edits do not rewrite the slot snapshot.
    navigate(page, 'screen-master-profile')
    field.fill('Другой адрес профиля')
    field.blur()
    navigate(page, 'screen-master-menu')
    navigate(page, 'screen-master-profile')
    expect(field).to_have_value('Другой адрес профиля')
    assert api.slots[-1]['address'] == selected_address
    navigate(page, 'screen-master-add')
    expect(city).to_have_value('')
    expect(address).to_have_value('')
    page.evaluate("window.switchRole('model')")
    expect(page.locator('#screen-model-menu')).to_be_visible()
    page.locator('#model-menu-services button').first.click()
    expect(page.locator('#model-search-results')).to_contain_text(selected_address)


@pytest.mark.parametrize('failure', [403, 429, 503, 'network'])
def test_manual_save_and_publication_when_dadata_unavailable(ui, failure):
    page, api = ui
    api.suggestion_failure = failure
    navigate(page, 'screen-master-profile')
    field = page.locator('#master-address-input')
    field.fill('Ручной адрес мастера')
    expect(page.locator('#master-address-input-suggestion-status')).to_contain_text('Можно ввести вручную')
    field.blur()
    navigate(page, 'screen-master-menu')
    navigate(page, 'screen-master-profile')
    expect(field).to_have_value('Ручной адрес мастера')
    slot_form(page)
    city = page.locator('#slot-city-input')
    city.fill('Тула')
    expect(page.locator('#slot-city-input-suggestion-status')).to_contain_text('Можно ввести вручную')
    # Empty address remains valid even when suggestions are unavailable.
    page.get_by_role('button', name='Опубликовать слот', exact=True).click()
    expect(page.locator('#screen-master-success')).to_be_visible()
    assert api.slots[-1]['city']=='Тула'
    assert api.slots[-1]['address']==''
    slot_form(page)
    city.fill('Казань')
    page.locator('#slot-address-input').fill('Ручной адрес слота')
    expect(page.locator('#slot-address-input-suggestion-status')).to_contain_text('Можно ввести вручную')
    page.get_by_role('button', name='Опубликовать слот', exact=True).click()
    expect(page.locator('#screen-master-success')).to_be_visible()
    assert api.slots[-1]['address']=='Ручной адрес слота'
    assert api.master['address']=='Ручной адрес мастера'


def test_manual_city_clears_id_and_empty_suggestions_do_not_block(ui):
    page, api = ui
    slot_form(page)
    city=page.locator('#slot-city-input')
    city.fill('Мос')
    page.locator('#slot-city-input-suggestions [role=option]').first.click()
    city.fill('Казань')
    api.suggestion_empty=True
    page.locator('#slot-address-input').fill('Ленина')
    expect(page.locator('#slot-address-input-suggestion-status')).to_contain_text('Нет подходящих вариантов')
    body=[b for e,b in api.calls if e=='address-suggest' and b['query']=='Ленина'][-1]
    assert body['city']=='Казань'
    assert 'city_id' not in body
    page.get_by_role('button', name='Опубликовать слот', exact=True).click()
    expect(page.locator('#screen-master-success')).to_be_visible()
    assert api.slots[-1]['address']=='Ленина'


@pytest.mark.parametrize('width,height', [(320,568),(360,640),(390,844),(430,932)])
def test_mobile_list_and_keyboard_navigation(ui, width, height, tmp_path):
    page, api=ui
    page.set_viewport_size({'width':width,'height':height})
    slot_form(page)
    city=page.locator('#slot-city-input')
    city.fill('Мос')
    options=page.locator('#slot-city-input-suggestions [role=option]')
    expect(options.first).to_be_visible()
    assert options.first.bounding_box()['height']>=44
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
    assert page.evaluate("document.querySelector('#slot-city-input-suggestions').getBoundingClientRect().height<=202")
    city.press('ArrowDown')
    city.press('Enter')
    expect(city).to_have_value('Москва')
    city.fill('Мос')
    expect(options.first).to_be_visible()
    city.press('Escape')
    expect(page.locator('#slot-city-input-suggestions')).to_be_hidden()
    # Resize models the visual space available with a keyboard; real IME remains a manual check.
    page.set_viewport_size({'width':width,'height':max(300,height-250)})
    city.fill('Моск')
    expect(options.first).to_be_visible()
    page.screenshot(path=str(tmp_path/f'city-{width}.png'),full_page=True)
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')


def test_debounce_stale_responses_navigation_and_safe_text(ui):
    page, api=ui
    # Exercise the actual component against a delayed provider that ignores abort.
    page.evaluate("""async () => {
        const {attachAddressAutocomplete}=await import(new URL('components/address-autocomplete.js', new URL(document.querySelector('script[type=module]').getAttribute('src'), location.href)).href);
        const input=document.createElement('input'); input.id='race-input'; document.body.append(input);
        window.__pending=[];
        attachAddressAutocomplete(input,{mode:'city',delay:20,suggest:args=>new Promise(resolve=>__pending.push({args,resolve}))});
    }""")
    field=page.locator('#race-input')
    field.fill('Старый')
    page.wait_for_function('()=>__pending.length===1')
    field.fill('Новый')
    page.wait_for_function('()=>__pending.length===2')
    page.evaluate("__pending[1].resolve([{value:'Новый',label:'<img src=x onerror=alert(1)>',cityId:null}])")
    listbox=page.locator('#race-input-suggestions')
    expect(listbox).to_contain_text('<img src=x onerror=alert(1)>')
    assert listbox.locator('img').count()==0
    page.evaluate("__pending[0].resolve([{value:'Старый',label:'Старый',cityId:null}])")
    expect(listbox).not_to_contain_text('Старый')
    field.fill('Закрытый')
    page.wait_for_function('()=>__pending.length===3')
    navigate(page,'screen-master-profile')
    page.evaluate("__pending[2].resolve([{value:'Закрытый',label:'Закрытый',cityId:null}])")
    expect(listbox).to_be_hidden()
    field.fill('Н')
    page.wait_for_timeout(80)
    assert page.evaluate('__pending.length')==3
    # Dispatch a burst within one browser task. Separate Playwright calls can take
    # longer than the debounce interval on a busy machine.
    field.evaluate("""input => {
        for (const value of ['Но','Нов','Новы','Новый']) {
            input.value=value;
            input.dispatchEvent(new Event('input',{bubbles:true}));
        }
    }""")
    page.wait_for_function('()=>__pending.length===4')
    assert page.evaluate('__pending[3].args.query')=='Новый'
    field.blur()
    page.evaluate('__pending[3].resolve([])')


def test_slow_profile_load_does_not_replace_new_input(ui):
    page, api = ui
    original = api.master.copy()
    api.hold_profile = lambda body: body['action'] == 'ensure'
    navigate(page, 'screen-master-profile')
    page.wait_for_timeout(100)
    assert api.held_profiles
    field = page.locator('#master-address-input')
    field.fill('Начатый до загрузки адрес')
    api.hold_profile = None
    for route in api.held_profiles:
        route.fulfill(json={'profile':original})
    api.held_profiles.clear()
    with page.expect_response(lambda response: response.url.endswith('/functions/v1/master-profile')
                              and response.request.post_data_json.get('profile', {}).get('address') == 'Начатый до загрузки адрес'):
        field.blur()
    navigate(page, 'screen-master-menu')
    navigate(page, 'screen-master-profile')
    expect(field).to_have_value('Начатый до загрузки адрес')
    assert api.master['address']=='Начатый до загрузки адрес'


def test_profile_edits_save_in_order_when_first_write_is_slow(ui):
    page, api = ui
    navigate(page, 'screen-master-profile')
    field = page.locator('#master-address-input')
    expect(field).to_have_value(api.master['address'])
    # Hold at the fixture's single route owner. Stacking page/context routes and
    # removing a handler while its fallback is running can fulfill a route twice.
    api.hold_profile = lambda body: body.get('profile',{}).get('address')=='Первый адрес'
    field.fill('Первый адрес')
    field.blur()
    page.wait_for_timeout(100)
    assert len(api.held_profiles)==1
    field.fill('Второй адрес')
    field.blur()
    assert not any(b.get('profile',{}).get('address')=='Второй адрес' for e,b in api.calls if e=='master-profile')
    api.hold_profile = None
    route=api.held_profiles.pop()
    with page.expect_response(lambda response: response.url.endswith('/functions/v1/master-profile')
                              and response.request.post_data_json.get('profile', {}).get('address') == 'Второй адрес'):
        route.fulfill(json=api.respond('master-profile',route.request.post_data_json))
    navigate(page,'screen-master-menu')
    navigate(page,'screen-master-profile')
    expect(field).to_have_value('Второй адрес')
    assert api.master['address']=='Второй адрес'
