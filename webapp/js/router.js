import {
    setScreen
} from './state.js';


const HIDDEN_NAV_SCREENS = new Set([
    'screen-model-success',
    'screen-master-success',
    'screen-master-add'
]);


let activeRouter = null;


export function createRouter({
    defaultScreen,
    getCurrentRole
}) {
    let started = false;


    function getScreen(screenId) {
        return document.getElementById(
            screenId
        );
    }


    function getAllScreens() {
        return Array.from(
            document.querySelectorAll(
                '.screen'
            )
        );
    }


    function updateScreens(
        screenId
    ) {
        getAllScreens().forEach(
            (screen) => {
                screen.classList.toggle(
                    'active',
                    screen.id === screenId
                );
            }
        );
    }


    function updateBottomNavigation(
        screenId
    ) {
        const bottomNavigation =
            document.getElementById(
                'bottom-navigation'
            );


        if (!bottomNavigation) {
            return;
        }


        bottomNavigation.style.display =
            HIDDEN_NAV_SCREENS.has(
                screenId
            )
                ? 'none'
                : 'flex';
    }


    function scrollToTop() {
        window.scrollTo({
            top: 0,
            behavior: 'instant'
        });
    }


    function routerNavigate(
        screenId,
        options = {}
    ) {
        const screen =
            getScreen(screenId);


        if (!screen) {
            console.warn(
                `Screen not found: ${screenId}`
            );

            return false;
        }


        updateScreens(
            screenId
        );

        updateBottomNavigation(
            screenId
        );

        setScreen(
            screenId
        );

        scrollToTop();


        document.dispatchEvent(
            new CustomEvent(
                'bb:navigation',
                {
                    detail: {
                        screenId,
                        role:
                            getCurrentRole(),
                        options
                    }
                }
            )
        );


        return true;
    }


    function start() {
        if (started) {
            return;
        }


        started = true;


        const activeScreen =
            document.querySelector(
                '.screen.active'
            );


        const initialScreen =
            activeScreen?.id ||
            defaultScreen;


        routerNavigate(
            initialScreen
        );
    }


    function getCurrentScreen() {
        return (
            document.querySelector(
                '.screen.active'
            )?.id || null
        );
    }


    activeRouter = {
        start,
        navigate: routerNavigate,
        getCurrentScreen
    };


    return activeRouter;
}


export function navigate(
    screenId,
    options = {}
) {
    if (!activeRouter) {
        console.warn(
            'Router is not initialized.'
        );

        return false;
    }


    return activeRouter.navigate(
        screenId,
        options
    );
}