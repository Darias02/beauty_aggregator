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
            333 / Math.max(items.length, 1);

        indicator.style.width =
            `${itemWidth}px`;


        items.forEach((item, index) => {
            const element =
                document.createElement('div');

            element.className = 'nav-item';

            element.style.width =
                `${itemWidth}px`;

            element.innerHTML = `
                <div
                    class="nav-text"
                    style="margin-top: 15px;"
                >
                    ${escapeHtml(item.text)}
                </div>
            `;


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
            element.classList.toggle(
                'active',
                index === activeIndex
            );
        });


        if (activeIndex >= 0) {
            indicator.style.left =
                `${activeIndex * (333 / items.length)}px`;
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