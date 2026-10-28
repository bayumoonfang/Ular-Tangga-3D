/** Ikon SVG vektor (stroke) agar tombol presisi & konsisten di semua perangkat (emoji bergantung font OS). */
const PATHS = {
  play: '<polygon points="7,4.5 19.5,12 7,19.5" class="f"/>',
  pause: '<rect x="6" y="4.5" width="4" height="15" rx="1.2" class="f"/><rect x="14" y="4.5" width="4" height="15" rx="1.2" class="f"/>',
  fast: '<polygon points="4,5 12,12 4,19" class="f"/><polygon points="12,5 20,12 12,19" class="f"/>',
  camera: '<rect x="3" y="6.5" width="12.5" height="11" rx="2.5"/><path d="M15.5 10.5 21 7.5v9l-5.5-3z" class="f"/>',
  volume: '<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" class="f"/><path d="M15.5 9a4.2 4.2 0 0 1 0 6M18 6.5a8 8 0 0 1 0 11"/>',
  mute: '<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" class="f"/><path d="m16 9.5 5 5m0-5-5 5"/>',
  settings: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9M4 12h3M11 12h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/><circle cx="9" cy="12" r="0.01"/>',
  home: '<path d="M4 11 12 4l8 7"/><path d="M6 9.5V20h12V9.5"/><path d="M10 20v-5.5h4V20"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.3a2.6 2.6 0 0 1 5 .9c0 1.7-2.5 2-2.5 3.6"/><circle cx="12" cy="17.2" r="0.6" class="f"/>',
  dice: '<rect x="4" y="4" width="16" height="16" rx="4"/><circle cx="9" cy="9" r="1.2" class="f"/><circle cx="15" cy="15" r="1.2" class="f"/><circle cx="15" cy="9" r="1.2" class="f"/><circle cx="9" cy="15" r="1.2" class="f"/>',
  copy: '<rect x="8.5" y="8.5" width="11" height="11" rx="2.5"/><path d="M15.5 8.5V6.5a2.5 2.5 0 0 0-2.5-2.5H6.5A2.5 2.5 0 0 0 4 6.5V13a2.5 2.5 0 0 0 2.5 2.5h2"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
  users: '<circle cx="9" cy="8.5" r="3.2"/><path d="M3 19a6 6 0 0 1 12 0"/><circle cx="17" cy="9.5" r="2.4"/><path d="M17.5 14.2A5 5 0 0 1 21 19"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  exit: '<path d="M10 4.5H6.5A2.5 2.5 0 0 0 4 7v10a2.5 2.5 0 0 0 2.5 2.5H10"/><path d="M15 8l4 4-4 4M19 12H9.5"/>',
  back: '<path d="M10 6 4 12l6 6M4 12h16"/>',
  refresh: '<path d="M20 5v5h-5"/><path d="M19.5 10A8 8 0 1 0 20 13"/>',
  crown: '<path d="M4 18h16L19 8l-4.5 4L12 6l-2.5 6L5 8z" class="f"/>',
  resume: '<polygon points="7,4.5 19.5,12 7,19.5"/>',
  trophy: '<path d="M7 4h10v5a5 5 0 0 1-10 0z" class="f"/><path d="M7 6H4v1.5A3.5 3.5 0 0 0 7.5 11M17 6h3v1.5a3.5 3.5 0 0 1-3.5 3.5"/><path d="M12 14v3.5M8.5 20h7M10 17.5h4"/>',
  repeat: '<path d="M4 11V9.5A2.5 2.5 0 0 1 6.5 7H18m0 0-3-3m3 3-3 3"/><path d="M20 13v1.5a2.5 2.5 0 0 1-2.5 2.5H6m0 0 3 3m-3-3 3-3"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>',
  chat: '<path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v7a2.5 2.5 0 0 1-2.5 2.5H10l-4.5 4v-4A1.5 1.5 0 0 1 4 14.5z"/>',
  smile: '<circle cx="12" cy="12" r="9"/><path d="M8 14a5 5 0 0 0 8 0"/><circle cx="9" cy="9.5" r="1" class="f"/><circle cx="15" cy="9.5" r="1" class="f"/>',
  send: '<path d="M4 12 20 4l-4.5 16-3.5-6.5z" class="f"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  wifi: '<path d="M3 9.5a14 14 0 0 1 18 0M6 13a9.5 9.5 0 0 1 12 0M9 16.5a5 5 0 0 1 6 0"/><circle cx="12" cy="19.5" r="0.8" class="f"/>',
} as const;

export type IconName = keyof typeof PATHS;

/** Elemen <span class="ico"> berisi SVG; ukuran mengikuti font-size induk. */
export function icon(name: IconName): HTMLElement {
  const el = document.createElement('span');
  el.className = 'ico';
  el.setAttribute('aria-hidden', 'true');
  el.innerHTML = `<svg viewBox="0 0 24 24" focusable="false">${PATHS[name]}</svg>`;
  return el;
}
