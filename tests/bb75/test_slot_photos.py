"""Offline browser verification of the private photo API contract, never production."""
import time
from email.parser import BytesParser
from email.policy import default
from playwright.sync_api import expect
from test_ui import ui, server, master, navigate, popup, ROOT  # noqa: F401
from mock_api import PNG
import struct
import zlib

# Synthetic colour sample, not a real client's photo.
def sample_png():
    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data))
    rows = b''.join(b'\0' + bytes(v for x in range(240) for v in (int(150+x/3), int(80+y/3), int(110+x/5))) for y in range(240))
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB',240,240,8,2,0,0,0)) + chunk(b'IDAT', zlib.compress(rows)) + chunk(b'IEND', b'')
SAMPLE = sample_png()
import pytest


def photo(name='work.png', content=SAMPLE, mime='image/png'):
    return {'name': name, 'mimeType': mime, 'buffer': content}


def photos_api(page, api):
    state = {'photos': {}, 'uploads': [], 'fail': False, 'lists': 0, 'ttl': 3600000}
    def route(r):
        message = BytesParser(policy=default).parsebytes(
            ('Content-Type: ' + r.request.headers['content-type'] + '\r\n\r\n').encode() + r.request.post_data_buffer)
        fields = {part.get_param('name', header='content-disposition'): part.get_payload(decode=True)
                  for part in message.iter_parts()}
        action = fields['action'].decode(); slot = int(fields['slot_id'])
        api.calls.append(('slot-photos', {'action': action, 'slot_id': slot}))
        if action == 'list':
            state['lists'] += 1
            photo_origin = 'https://photos.example.test' if r.request.url.startswith('https:') else page.url.rstrip('/')
            r.fulfill(json={'photos': [{'photo_id': p, 'url': photo_origin + '/fixture-photo.png?version=' + str(state['lists']),
                                      'expires_at': int(time.time()*1000)+state['ttl']} for p in state['photos'].get(slot, [])]})
        elif action == 'upload':
            state['uploads'].append(fields)
            if state['fail']:
                r.fulfill(status=503,json={'error': {'code':'PHOTOS_UNAVAILABLE'}}); return
            pid = fields['photo_id'].decode()
            ids = state['photos'].setdefault(slot, [])
            if pid not in ids: ids.append(pid)
            r.fulfill(json={'uploaded': True})
        else:
            pid = fields['photo_id'].decode()
            ids = state['photos'].setdefault(slot, [])
            if pid in ids: ids.remove(pid)
            r.fulfill(json={'deleted': True})
    page.route('**/functions/v1/slot-photos',route)
    page.route('**/fixture-photo.png*',lambda r: r.fulfill(body=SAMPLE,content_type='image/png'))
    return state


def open_form(page):
    master(page); navigate(page,'screen-master-add')
    page.locator('#selected-service').click()
    page.locator('#service-dropdown .dropdown-item').first.click()
    page.locator('#slot-city-input').fill('Тула')
    page.locator('#slot-time-input').fill('23:59')
    page.locator('.calendar-day:not([style])').last.click()


@pytest.mark.parametrize('width',[320,390,430])
def test_private_photo_form_retry_and_mobile_layout(ui,width):
    page,api = ui; state = photos_api(page,api)
    page.set_viewport_size({'width':width,'height':760}); open_form(page)
    picker = page.locator('#slot-photo-picker')
    picker.locator('input[type=file]').set_input_files([photo(str(n)+'.png') for n in range(3)])
    expect(picker.locator('img')).to_have_count(3)
    expect(picker.get_by_role('button',name='Добавить фото',exact=True)).to_be_hidden()
    picker.get_by_role('button',name='Заменить',exact=True).first.click()
    picker.locator('input[type=file]').set_input_files(photo('replacement.png'))
    expect(picker.locator('img')).to_have_count(3)
    picker.get_by_role('button',name='Удалить',exact=True).first.click()
    expect(picker.locator('img')).to_have_count(2)
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
    page.screenshot(path=str(ROOT / f'tests/bb75/artifacts/private-slot-form-{width}.png'),full_page=True)
    state['fail'] = True
    page.get_by_role('button',name='Опубликовать слот',exact=True).click()
    expect(picker.locator('[role=status]')).to_contain_text('Слот №')
    expect(page.locator('#screen-master-add')).to_be_visible()
    creates = len([b for e,b in api.calls if e=='slots-write' and b.get('action')=='create'])
    assert creates == 1
    state['fail'] = False
    page.get_by_role('button',name='Повторить загрузку фото',exact=True).click()
    expect(page.locator('#screen-master-success')).to_be_visible()
    assert len([b for e,b in api.calls if e=='slots-write' and b.get('action')=='create']) == 1
    assert state['uploads'][0]['photo_id'] == state['uploads'][1]['photo_id']
    assert all(len(upload['photo']) <= 700*1024 for upload in state['uploads'])


def test_empty_slot_and_invalid_images(ui):
    page,api=ui; photos_api(page,api); open_form(page)
    picker=page.locator('#slot-photo-picker')
    for file, text in [(photo('iphone.heic',b'heic','image/heic'),'HEIC'),
                       (photo('bad.png',b'broken'),'Не удалось прочитать'),
                       (photo('huge.jpg',b'x'*(25*1024*1024+1),'image/jpeg'),'25 МБ')]:
        picker.locator('input').set_input_files(file)
        expect(picker.locator('[role=status]')).to_contain_text(text)
        expect(picker.locator('img')).to_have_count(0)
    page.get_by_role('button',name='Опубликовать слот',exact=True).click()
    expect(page.locator('#screen-master-success')).to_be_visible()
    assert not any(e=='slot-photos' and b.get('action') == 'upload' for e,b in api.calls)


def test_search_gallery_refresh_and_booking(ui):
    page,api=ui; state=photos_api(page,api)
    page.clock.install()
    state['photos'][api.slots[0]['slot_id']]=['152931fc-d80b-45c9-a371-fb21e7e02311','252931fc-d80b-45c9-a371-fb21e7e02311']
    page.locator('#model-menu-services button').first.click()
    card=page.locator('.available-slot-card').first
    expect(card.locator('.slot-photo-thumb')).to_have_count(1)
    card.locator('summary').click()
    expect(card.locator('.slot-photo-thumb')).to_have_count(2)
    card.locator('.slot-photo-thumb').first.click()
    expect(page.get_by_role('dialog')).to_be_visible()
    old=page.get_by_role('dialog').locator('img').get_attribute('src')
    # Advance to the renewal window while the full-size viewer remains open.
    page.clock.fast_forward(59*60*1000+2000)
    page.wait_for_function('(old)=>document.querySelector("dialog img").src!==old',arg=old)
    page.get_by_role('dialog').get_by_role('button',name='Закрыть').click()
    page.screenshot(path=str(ROOT/'tests/bb75/artifacts/private-slot-search.png'),full_page=True)
    card.get_by_role('button',name='Записаться',exact=True).click()
    expect(page.locator('#screen-model-success')).to_be_visible()


def test_owner_can_manage_saved_photos(ui):
    page,api=ui; state=photos_api(page,api)
    master(page); navigate(page,'screen-master-records')
    card=page.locator('.record-card').first
    expect(card.get_by_role('button',name='Добавить фото',exact=True)).to_be_visible()
    card.locator('input[type=file]').set_input_files(photo())
    expect(card.locator('.slot-photo-thumb')).to_have_count(1)
    card.get_by_role('button',name='Удалить фото 1',exact=True).click()
    expect(card.locator('.slot-photo-thumb')).to_have_count(0)
