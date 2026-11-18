const paths = {
    city: '<path d="M3 21V7h7v14m0-10h11v10M6 11h1m-1 4h1m7 0h1m3 0h1m-5 3h1m3 0h1M1 21h22"/>',
    address: '<path d="M19 10c0 5-7 11-7 11S5 15 5 10a7 7 0 1 1 14 0Z"/><circle cx="12" cy="10" r="2.5"/>',
    description: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10v.1"/>'
};

export function outlineIcon(name) {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]}</svg>`;
}
