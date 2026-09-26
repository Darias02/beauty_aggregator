const navStructure = {
    model: [
        { id: 'menu', text: 'Меню', screen: 'screen-model-menu' },
        { id: 'search', text: 'Поиск', screen: 'screen-model-search' },
        { id: 'records', text: 'Записи', screen: 'screen-model-records' },
        { id: 'profile', text: 'Профиль', screen: 'screen-model-profile' }
    ],
    master: [
        { id: 'menu', text: 'Меню', screen: 'screen-master-menu' },
        { id: 'records', text: 'Слоты', screen: 'screen-master-records' },
        { id: 'profile', text: 'Профиль', screen: 'screen-master-profile' }
    ]
};

let currentRole = 'model';

window.navigate = function(screenId) {
    document.querySelectorAll('.screen').forEach(el => el.classList.remove('active'));
    document.getElementById(screenId).classList.add('active');
    window.scrollTo(0, 0); 
    
    const bottomNav = document.getElementById('bottom-navigation');
    if (screenId.includes('success') || screenId.includes('add')) {
        bottomNav.style.display = 'none';
    } else {
        bottomNav.style.display = 'flex';
        const screenIndex = navStructure[currentRole].findIndex(i => i.screen === screenId);
        if (screenIndex !== -1) {
            const itemWidth = 333 / navStructure[currentRole].length;
            document.getElementById('nav-indicator').style.left = (screenIndex * itemWidth) + 'px';
            document.querySelectorAll('.nav-item').forEach((el, idx) => el.classList.toggle('active', idx === screenIndex));
        }
    }
};

window.switchRole = function(role) {
    currentRole = role;
    renderNav();
    window.navigate(role === 'model' ? 'screen-model-menu' : 'screen-master-menu');
};

function renderNav() {
    const navContainer = document.getElementById('bottom-navigation');
    const items = navStructure[currentRole];
    
    Array.from(navContainer.children).forEach(child => {
        if (child.id !== 'nav-indicator') child.remove();
    });
    
    const indicator = document.getElementById('nav-indicator');
    const itemWidth = 333 / items.length;
    indicator.style.width = itemWidth + 'px';

    items.forEach((item, index) => {
        const div = document.createElement('div');
        div.className = `nav-item ${index === 0 ? 'active' : ''}`;
        div.style.width = itemWidth + 'px';
        div.innerHTML = `<div class="nav-text" style="margin-top: 15px;">${item.text}</div>`;
        div.onclick = () => window.navigate(item.screen);
        navContainer.appendChild(div);
    });
    document.getElementById('nav-indicator').style.left = '0px';
}

window.toggleDropdown = function(id) { 
    document.getElementById(id).classList.toggle('active'); 
};

window.selectItem = function(spanId, dropId, name, event) {
    event.stopPropagation(); 
    document.getElementById(spanId).innerText = name;
    document.getElementById(dropId).classList.remove('active');
};

document.addEventListener('click', function(event) {
    const cityDropdown = document.getElementById('city-dropdown');
    const serviceDropdown = document.getElementById('service-dropdown');
    if (cityDropdown && !event.target.closest('.input-box')) cityDropdown.classList.remove('active');
    if (serviceDropdown && !event.target.closest('.input-box')) serviceDropdown.classList.remove('active');
});

function initCalendar() {
    const grid = document.getElementById('calendar-grid');
    const header = document.getElementById('calendar-header');
    if (!grid || !header) return;

    grid.innerHTML = '';
    const days = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
    days.forEach(d => {
        const el = document.createElement('div');
        el.className = 'calendar-day-name';
        el.innerText = d;
        grid.appendChild(el);
    });

    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth();
    
    header.innerText = now.toLocaleString('ru-RU', { month: 'long', year: 'numeric' });

    const firstDay = new Date(year, month, 1).getDay();
    const emptyDays = firstDay === 0 ? 6 : firstDay - 1; 
    const daysInMonth = new Date(year, month + 1, 0).getDate();

    for (let i = 0; i < emptyDays; i++) {
        grid.appendChild(document.createElement('div'));
    }

    for (let i = 1; i <= daysInMonth; i++) {
        const day = document.createElement('div');
        day.className = 'calendar-day';
        
        if (i < now.getDate()) {
            day.style.opacity = '0.3';
            day.style.pointerEvents = 'none';
        }
        
        day.innerText = i;
        day.onclick = () => {
            document.querySelectorAll('.calendar-day').forEach(d => d.classList.remove('selected'));
            day.classList.add('selected');
            window.selectedDate = new Date(year, month, i);
        };
        grid.appendChild(day);
    }
}

window.createRealSlot = async function() {
    const tgUser = window.Telegram?.WebApp?.initDataUnsafe?.user;
    const userId = tgUser?.id;
    if (!userId) { alert('Откройте приложение через Telegram.'); return; }

    const serviceName = document.getElementById('selected-service')?.textContent?.trim();
    if (serviceName === 'Выберите услугу') { alert('Выберите услугу.'); return; }

    const { data: service } = await window.supabaseClient.from('services').select('service_id').eq('name', serviceName).single();
    if (!service) { alert('Услуга не найдена.'); return; }

    const city = document.getElementById('slot-city-input')?.value || '';
    const address = document.getElementById('slot-address-input')?.value?.trim() || '';
    const description = document.getElementById('slot-description-input')?.value?.trim() || '';
    
    const timeInput = document.getElementById('slot-time-input')?.value;

    if (!window.selectedDate || !timeInput) { 
        alert('Выберите дату в календаре и укажите время.'); 
        return; 
    }

    const [hours, minutes] = timeInput.split(':');
    const dt = new Date(window.selectedDate);
    dt.setHours(hours, minutes, 0);

    const { error } = await window.supabaseClient.from('slots').insert({
        master_id: userId, 
        service_id: service.service_id, 
        date_time: dt.toISOString(),
        status: 'Свободен', 
        city, 
        address, 
        description
    });

    if (error) { alert('Не удалось создать слот.'); return; }
    window.navigate('screen-master-success');
};

document.addEventListener('DOMContentLoaded', () => {
    renderNav();
    initCalendar();
    if (window.renderRealServices) window.renderRealServices();
    
    if (window.Telegram && window.Telegram.WebApp) {
        window.Telegram.WebApp.expand();
    }
});