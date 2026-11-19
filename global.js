const { menu } = iina;
let label = 'Thumbnails';
try { if (/^zh/i.test(Intl.DateTimeFormat().resolvedOptions().locale || '')) label = '缩略图'; } catch (_) {}
menu.addItem(menu.item(label, () => {}));
