"""Exercise real DaData through the loopback preview; never print credentials or traces."""
import json
from pathlib import Path
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright, expect

URL = 'http://127.0.0.1:8076'
ARTIFACT = Path.home() / '.config/beauty-booking/local-address-check.png'


def main():
    blocked, responses, errors = [], [], []
    with sync_playwright() as p:
        browser = p.chromium.launch(channel='chrome', headless=True)
        context = browser.new_context(viewport={'width':390, 'height':844},
                                      is_mobile=True, has_touch=True, service_workers='block')
        context.set_default_timeout(10000)
        def route(r):
            if urlsplit(r.request.url).netloc != '127.0.0.1:8076':
                blocked.append(True)
                r.abort()
            else:
                r.continue_()
        context.route('**/*', route)
        page = context.new_page()
        page.on('pageerror', lambda _error: errors.append(True))
        page.on('response', lambda r: responses.append(r.status) if r.url.endswith('/address-suggest') else None)
        try:
            page.goto(URL)
            expect(page.locator('#model-menu-services')).to_contain_text('Маникюр')
            # Forged requests must fail before the external service is called.
            assert page.evaluate("""async()=> (await fetch('/functions/v1/address-suggest',{
                method:'POST',headers:{'Content-Type':'application/json'},
                body:JSON.stringify({init_data:'forged',mode:'city',query:'Мос'})})).status""")==401
            page.evaluate("window.switchRole('master')")
            expect(page.locator('#screen-master-menu')).to_be_visible()
            page.evaluate("window.navigate('screen-master-add')")
            page.locator('#selected-service').click()
            page.locator('#service-dropdown .dropdown-item').first.click()
            city=page.locator('#slot-city-input')
            expect(city).to_have_value('')
            city.fill('Москва')
            city_option=page.locator('#slot-city-input-suggestions [role=option]').first
            expect(city_option).to_be_visible(timeout=12000)
            city_option.tap()
            expect(city).to_have_value('Москва')
            address=page.locator('#slot-address-input')
            address.fill('Тверская 1')
            option=page.locator('#slot-address-input-suggestions [role=option]').first
            expect(option).to_be_visible(timeout=12000)
            label=option.inner_text()
            assert 'Тверская' in label and ('д 1' in label or 'дом 1' in label)
            option.tap()
            slot_address=address.input_value()
            assert slot_address==label
            page.locator('#slot-time-input').fill('23:59')
            page.locator('.calendar-day:not([style])').last.click()
            page.get_by_role('button',name='Опубликовать слот',exact=True).click()
            expect(page.locator('#screen-master-success')).to_be_visible()
            # Read the saved record back through the local API, not the field value.
            saved=page.evaluate("""async()=> (await (await fetch('/functions/v1/slots-read',{
                method:'POST',headers:{'Content-Type':'application/json'},
                body:JSON.stringify({init_data:Telegram.WebApp.initData,action:'master'})})).json()).slots.at(-1)""")
            assert saved['city']=='Москва' and saved['address']==slot_address
            page.evaluate("window.navigate('screen-master-profile')")
            field=page.locator('#master-address-input')
            expect(field).to_have_value('Тестовый адрес')
            field.fill('Москва Арбат 12')
            profile_option=page.locator('#master-address-input-suggestions [role=option]').first
            expect(profile_option).to_be_visible(timeout=12000)
            profile_option.tap()
            profile_address=field.input_value()
            assert profile_address and profile_address!=slot_address
            page.evaluate("window.navigate('screen-master-menu')")
            page.evaluate("window.navigate('screen-master-profile')")
            expect(field).to_have_value(profile_address)
            reread=page.evaluate("""async()=> (await (await fetch('/functions/v1/slots-read',{
                method:'POST',headers:{'Content-Type':'application/json'},
                body:JSON.stringify({init_data:Telegram.WebApp.initData,action:'master'})})).json()).slots.at(-1)""")
            assert reread['address']==slot_address
            page.evaluate("window.switchRole('model')")
            expect(page.locator('#screen-model-menu')).to_be_visible()
            page.locator('#model-menu-services button').first.click()
            expect(page.locator('#model-search-results')).to_contain_text(slot_address)
            # Real browser refresh keeps records while this local process is running.
            page.reload()
            expect(page.locator('#model-menu-services')).to_contain_text('Маникюр')
            page.evaluate("window.switchRole('master')")
            expect(page.locator('#screen-master-menu')).to_be_visible()
            page.evaluate("window.navigate('screen-master-profile')")
            expect(field).to_have_value(profile_address)
            expect(page.locator('#screen-master-profile')).to_be_visible()
            page.screenshot(path=str(ARTIFACT),full_page=True,animations='disabled')
            ARTIFACT.chmod(0o600)
            assert not blocked and not errors
            assert responses.count(200)>=3
            print(json.dumps({'result':'PASS','real_dadata_responses':responses.count(200),
                'city_selection':True,'full_address_selection':True,'local_slot_readback':True,
                'profile_reopen_and_refresh':True,'separate_profile_and_slot':True,
                'client_display':True,'forged_auth_rejected':True,'external_browser_requests':0}))
        except Exception:
            # Avoid Playwright's verbose exception dump, request bodies and browser traces.
            print(json.dumps({'result':'FAIL','suggestion_http_statuses':responses,
                              'blocked_external_requests':len(blocked),'browser_errors':len(errors)}))
            raise SystemExit(1)
        finally:
            browser.close()


if __name__=='__main__':
    main()
