export function createSkeleton({
    text = 'Загрузка...'
} = {}) {
    const element =
        document.createElement('div');

    element.className =
        'service-card skeleton-card';

    element.innerHTML = `
        <div class="skeleton-text">
            ${escapeHtml(text)}
        </div>
    `;

    return element;
}


export function showSkeleton(
    container,
    text = 'Загрузка...'
) {
    if (!container) {
        return;
    }

    container.innerHTML = '';

    container.appendChild(
        createSkeleton({ text })
    );
}


export function clearSkeleton(
    container
) {
    if (!container) {
        return;
    }

    container.innerHTML = '';
}


function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;');
}