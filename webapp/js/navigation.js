import { getCurrentAvatarUrl } from './telegram.js';

export function initNavigation({
    navStructure,
    getCurrentRole,
    navigate
}) {
    const navContainer =
        document.getElementById(
            'bottom-navigation'
        );

    const indicator =
        document.getElementById(
            'nav-indicator'
        );

    if (!navContainer || !indicator) {
        return;
    }


    function getItems() {
        const role = getCurrentRole();

        return navStructure[role] || [];
    }


    function render() {
        const items = getItems();

        navContainer
            .querySelectorAll('.nav-item')
            .forEach((element) => {
                element.remove();
            });


        const itemWidth =
            100 / Math.max(items.length, 1);

        indicator.style.width =
            `${itemWidth}%`;


        items.forEach((item, index) => {
            const element =
                document.createElement('button');

            element.className = 'nav-item';
            element.type = 'button';

            element.style.width =
                `${itemWidth}%`;

            const paths = {
                menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
                search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>',
                records: '<rect x="4" y="5" width="16" height="16" rx="3"/><path d="M8 3v4m8-4v4M4 11h16m-11 4h2m2 0h2"/>',
                profile: '<circle cx="12" cy="9" r="3"/><path d="M6 20v-2a6 6 0 0 1 12 0v2"/>'
            };
            const icon = `<svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[item.id] || paths.records}</svg>`;
            element.innerHTML = `
                ${item.id === 'profile' ? `<span class="nav-avatar" aria-hidden="true">${icon}</span>` : icon}
                <span class="nav-text">${escapeHtml(item.text)}</span>
            `;
            const avatar = element.querySelector('.nav-avatar');
            const avatarUrl = getCurrentAvatarUrl();
            if (avatar && avatarUrl) avatar.style.backgroundImage = `url("${avatarUrl}")`;



            element.addEventListener(
                'click',
                () => {
                    navigate(item.screen);
                }
            );


            navContainer.appendChild(element);
        });


        updateActive();
    }


    function updateActive(screenId = null) {
        const items = getItems();

        const currentScreen =
            screenId ||
            document.querySelector(
                '.screen.active'
            )?.id;


        const activeIndex =
            items.findIndex(
                (item) =>
                    item.screen === currentScreen
            );


        const elements =
            navContainer.querySelectorAll(
                '.nav-item'
            );


        elements.forEach((element, index) => {
            element.setAttribute('aria-current', index === activeIndex ? 'page' : 'false');
            element.classList.toggle(
                'active',
                index === activeIndex
            );
        });


        if (activeIndex >= 0) {
            indicator.style.left =
                `${activeIndex * (100 / items.length)}%`;
        } else {
            indicator.style.left = '0px';
        }
    }


    function renderForCurrentRole() {
        render();
    }


    document.addEventListener(
        'bb:navigation',
        (event) => {
            updateActive(
                event.detail?.screenId
            );
        }
    );


    document.addEventListener(
        'bb:role-changed',
        () => {
            renderForCurrentRole();
        }
    );


    render();


    return {
        render,
        updateActive,
        renderForCurrentRole
    };
}


function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;');
}