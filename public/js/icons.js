// Hand-drawn 24×24 line icons. Every glyph shares one visual language: no fill,
// 1.8px round strokes, `currentColor`, so a single CSS rule styles them all.

const GLYPHS = {
  // Skills
  build:
    '<path d="M3.5 7h17M3.5 12h17M3.5 17h17"/><path d="M7 7v5M17 12v5M12 17v-5"/>',
  blast:
    '<path d="M12 2v4M12 18v4M2 12h4M18 12h4M5 5l3 3M16 16l3 3M19 5l-3 3M8 16l-3 3"/><circle cx="12" cy="12" r="2.4"/>',
  overdrive: '<path d="M13 2.5 5.5 13h5l-1 8.5L18 11h-5l.8-8.5Z"/>',
  cryo:
    '<path d="M12 2v20M4.1 7l15.8 10M19.9 7 4.1 17"/><path d="m9 4 3 3 3-3M9 20l3-3 3 3M3 10l4 .8L6 7M21 14l-4-.8.9 3.8M3 14l4-1-1 3.8M21 10l-4 1 1-3.8"/>',

  // Buffs
  echo: '<path d="M9.5 5 4.5 12l5 7"/><path d="M15 5l5 7-5 7"/>',
  reject:
    '<path d="M12 2.8 5 6v5.7c0 4.2 3 6.8 7 9.5 4-2.7 7-5.3 7-9.5V6l-7-3.2Z"/><path d="M8.8 12.2l2.3 2.3 4.1-4.4"/>',
  luck:
    '<path d="M12 12c-1.7-4.2-6.4-4.8-6.4-1.5S10.3 12 12 12Z"/><path d="M12 12c4.2-1.7 4.8-6.4 1.5-6.4S12 10.3 12 12Z"/><path d="M12 12c1.7 4.2 6.4 4.8 6.4 1.5S13.7 12 12 12Z"/><path d="M12 12c-4.2 1.7-4.8 6.4-1.5 6.4S12 13.7 12 12Z"/><path d="M12 12v8.5"/>',
  examPass:
    '<circle cx="12" cy="12" r="8.6"/><path d="M7.8 12.4l2.7 2.6 5.7-5.8"/>',

  // Debuffs
  invert:
    '<path d="M8.5 20V4.5M8.5 4.5 5.5 7.5M8.5 4.5l3 3"/><path d="M15.5 4v15.5M15.5 19.5l-3-3M15.5 19.5l3-3"/>',
  fog:
    '<path d="M4 10h10.5M7 14h13M4.5 18h10.5"/><path d="M6.6 6.6a3.1 3.1 0 0 1 5.7-1.1 2.6 2.6 0 0 1 4 2.2"/>',
  drain:
    '<circle cx="12" cy="12" r="8.6"/><path d="M12 7v8.5M9 12.8l3 2.9 3-2.9"/>',
  lag:
    '<path d="M6.5 3h11M6.5 21h11"/><path d="M7.5 3c0 4.5 4.5 6.2 4.5 9s-4.5 4.5-4.5 9M16.5 3c0 4.5-4.5 6.2-4.5 9s4.5 4.5 4.5 9"/>',
  freeze: '<path d="M12 2.6 19.6 7v10L12 21.4 4.4 17V7L12 2.6Z"/><path d="M12 7.4v4.4l-3.2 2M12 11.8l3.2 2"/>',
  qte: '<path d="M12 2.6 19.6 7v10L12 21.4 4.4 17V7L12 2.6Z"/><path d="M12 7.4v4.4l-3.2 2M12 11.8l3.2 2M12 2.6v4.6"/>',
  misfortune:
    '<path d="M12 3.2a6.8 6.8 0 0 0-6.8 6.8c0 2.3 1.1 4 2.9 5.1v3a1.6 1.6 0 0 0 1.6 1.6h4.6a1.6 1.6 0 0 0 1.6-1.6v-3c1.8-1.1 2.9-2.8 2.9-5.1A6.8 6.8 0 0 0 12 3.2Z"/><circle cx="9.4" cy="10.4" r="1.35"/><circle cx="14.6" cy="10.4" r="1.35"/><path d="M10.4 20.6v-2.3M13.6 20.6v-2.3"/>',
  examFail:
    '<circle cx="12" cy="12" r="8.6"/><path d="M9.1 9.1l5.8 5.8M14.9 9.1l-5.8 5.8"/>',
  lockdown:
    '<path d="M4.5 3.5v17M19.5 3.5v17M4.5 8.5h15M4.5 15.5h15"/><path d="M9 8.5v7M15 8.5v7"/>',

  // Tradeoffs
  hijack: '<path d="M3.5 12h12M12.5 8l4 4-4 4"/><path d="M20.5 6.5v11"/>',
  exam: '<path d="M17.5 5h-11l5.6 7-5.6 7h11"/>',
  balance:
    '<path d="M12 3.5v17M7.5 20.5h9M4.5 7.5h15"/><path d="M6.5 7.5 4 12a2.8 2.8 0 0 0 5 0L6.5 7.5ZM17.5 7.5 15 12a2.8 2.8 0 0 0 5 0l-2.5-4.5Z"/>',
  mundane: '<circle cx="12" cy="12" r="8.6"/><path d="M6.2 6.2l11.6 11.6"/>',

  // Terrain
  soften:
    '<path d="M12 3.5s6 6.4 6 10a6 6 0 0 1-12 0c0-3.6 6-10 6-10Z"/><path d="M9.5 14.4c.4 1.6 1.5 2.5 3 2.7"/>',
  wall:
    '<rect x="3.5" y="4.5" width="17" height="15" rx="1"/><path d="M3.5 9.5h17M3.5 14.5h17M9.5 4.5v5M15 9.5v5M9.5 14.5v5"/>',
  harden:
    '<path d="m12 3 7.5 5.5-2.8 9.5H7.3L4.5 8.5 12 3Z"/><path d="m12 8 3.5 2.6-1.3 4.4H9.8L8.5 10.6 12 8Z"/>',
};

/** Inline SVG markup for one icon id. Unknown ids fall back to a neutral ring. */
export function effectIconSvg(id, className = 'effect-icon') {
  const glyph = GLYPHS[id] || GLYPHS.mundane;
  return `<svg class="${className}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${glyph}</svg>`;
}

export function hasIcon(id) {
  return Boolean(GLYPHS[id]);
}
