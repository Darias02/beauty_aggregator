import { suggestAddress } from '../data/address-suggestions.js';

// Inline, scrollable results remain in the document flow when the mobile keyboard opens.
export function attachAddressAutocomplete(
    input,
    {
        mode,
        context = () => ({}),
        onSelect = () => {},
        onEdit = () => {},
        suggest = suggestAddress,
        delay = 300,
    } = {},
) {
    if (!input) return null;
    const host = document.createElement('span');
    host.className = 'address-autocomplete';
    input.before(host);
    host.append(input);
    const list = document.createElement('span');
    list.className = 'address-suggestions';
    list.id = `${input.id}-suggestions`;
    list.setAttribute('role', 'listbox');
    list.setAttribute('aria-label', mode === 'city' ? 'Подсказки городов' : 'Подсказки адресов');
    list.hidden = true;
    const status = document.createElement('span');
    status.className = 'address-suggestions-status';
    status.id = `${input.id}-suggestion-status`;
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    host.append(list, status);
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-controls', list.id);
    input.setAttribute('aria-describedby', status.id);
    input.setAttribute('aria-expanded', 'false');
    input.setAttribute('autocomplete', 'off');
    input.setAttribute('spellcheck', 'false');
    let timer;
    let controller;
    let generation = 0;
    let active = -1;
    let items = [];
    let composing = false;
    let pointerDown = false;

    function close() {
        clearTimeout(timer);
        controller?.abort();
        generation++;
        items = [];
        active = -1;
        list.replaceChildren();
        list.hidden = true;
        status.textContent = '';
        input.setAttribute('aria-expanded', 'false');
        input.removeAttribute('aria-activedescendant');
        input.removeAttribute('aria-busy');
    }
    function fit() {
        if (list.hidden) return;
        const viewport = globalThis.visualViewport;
        const bottom = viewport ? viewport.height + viewport.offsetTop : globalThis.innerHeight;
        const available = bottom - input.getBoundingClientRect().bottom - 16;
        list.style.maxHeight = `${Math.max(60, Math.min(200, available))}px`;
    }
    function choose(index) {
        const item = items[index];
        if (!item) return;
        input.value = item.value;
        close();
        onSelect(item);
        // Selection and manual blur share the existing save boundary in profiles.
        input.dispatchEvent(new Event('change', { bubbles: true }));
        input.focus({ preventScroll: true });
    }
    function search() {
        close();
        const query = input.value.trim();
        if (composing || [...query].length < 2 || query.length > 200) return;
        const version = generation;
        const location = context();
        timer = setTimeout(async () => {
            controller = new AbortController();
            const abort = controller;
            const timeout = setTimeout(() => abort.abort(), 5000);
            input.setAttribute('aria-busy', 'true');
            status.textContent = 'Ищем варианты…';
            try {
                const result = await suggest({ mode, query, ...location, signal: abort.signal });
                if (version !== generation || document.activeElement !== input) return;
                items = result;
                status.textContent = items.length
                    ? ''
                    : 'Нет подходящих вариантов. Можно ввести вручную.';
                list.replaceChildren(...items.map((item, index) => {
                    const option = document.createElement('span');
                    option.className = 'address-suggestion';
                    option.id = `${list.id}-${index}`;
                    option.setAttribute('role', 'option');
                    option.setAttribute('aria-selected', 'false');
                    option.textContent = item.label;
                    // Keep focus/keyboard and prevent the profile blur save before selection.
                    option.addEventListener('pointerdown', (event) => event.preventDefault());
                    option.addEventListener('click', (event) => {
                        event.preventDefault();
                        choose(index);
                    });
                    return option;
                }));
                list.hidden = !items.length;
                input.setAttribute('aria-expanded', String(items.length > 0));
                fit();
            } catch {
                if (version === generation && document.activeElement === input) {
                    status.textContent = 'Подсказки недоступны. Можно ввести вручную.';
                }
            } finally {
                clearTimeout(timeout);
                if (version === generation) input.removeAttribute('aria-busy');
            }
        }, delay);
    }
    input.addEventListener('input', () => {
        onEdit();
        search();
    });
    input.addEventListener('focus', search);
    input.addEventListener('blur', () => {
        clearTimeout(timer);
        controller?.abort();
        generation++;
        // Closing an inline panel on pointerdown would move the button being tapped
        // before pointerup, cancelling its click. Keep layout until the tap completes.
        if (!pointerDown) close();
    });
    document.addEventListener('pointerdown', () => {
        pointerDown = true;
    }, true);
    const pointerEnd = () => {
        pointerDown = false;
        setTimeout(() => {
            if (document.activeElement !== input) close();
        }, 0);
    };
    document.addEventListener('pointerup', pointerEnd);
    document.addEventListener('pointercancel', pointerEnd);
    input.addEventListener('compositionstart', () => {
        composing = true;
        close();
    });
    input.addEventListener('compositionend', () => {
        composing = false;
        search();
    });
    input.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
            event.preventDefault();
            close();
            return;
        }
        if (event.key === 'Enter' && active >= 0) {
            event.preventDefault();
            choose(active);
            return;
        }
        if (!items.length || !['ArrowDown', 'ArrowUp'].includes(event.key)) return;
        event.preventDefault();
        active = (active + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        [...list.children].forEach((option, index) =>
            option.setAttribute('aria-selected', String(index === active))
        );
        input.setAttribute('aria-activedescendant', list.children[active].id);
        list.children[active].scrollIntoView({ block: 'nearest' });
    });
    // Hidden screens and late responses must not retain an active suggestion.
    document.addEventListener('bb:navigation', close);
    globalThis.visualViewport?.addEventListener('resize', fit);
    globalThis.visualViewport?.addEventListener('scroll', fit);
    return { close, refresh: search };
}
