// Thèmes : chaque thème est un simple objet de variables CSS. Pour en ajouter un : Themes.register('id', {...}).
// Script classique (non module), chargé dans <head> pour appliquer le thème avant le premier affichage.
(function () {
  const KEY = 'lecteur.theme';
  const THEMES = {
    dark: { label: 'Sombre', scheme: 'dark', color: '#121417', vars: {
      bg: '#121417', surface: '#1c2026', 'surface-2': '#262c34', text: '#e8eaed', muted: '#aab1bb', border: '#7d8896',
      accent: '#5cc8ff', 'on-accent': '#00212e', danger: '#ff8a80', ok: '#7fdc9a', focus: '#ffd54f', bw: '1px', 'focus-w': '3px' } },
    light: { label: 'Clair', scheme: 'light', color: '#f6f7f9', vars: {
      bg: '#f6f7f9', surface: '#ffffff', 'surface-2': '#eceff3', text: '#14181d', muted: '#4a5360', border: '#6b7480',
      accent: '#0b5cad', 'on-accent': '#ffffff', danger: '#b3261e', ok: '#1b6e3a', focus: '#8a4b00', bw: '1px', 'focus-w': '3px' } },
    contrast: { label: 'Contraste élevé', scheme: 'dark', color: '#000000', vars: {
      bg: '#000000', surface: '#000000', 'surface-2': '#141414', text: '#ffffff', muted: '#ececec', border: '#ffffff',
      accent: '#ffe600', 'on-accent': '#000000', danger: '#ff9a9a', ok: '#8dff9a', focus: '#00e5ff', bw: '2px', 'focus-w': '4px' } },
  };
  const mq = q => !!(window.matchMedia && window.matchMedia(q).matches);
  const resolve = id => id === 'auto'
    ? (mq('(prefers-contrast: more)') ? 'contrast' : mq('(prefers-color-scheme: light)') ? 'light' : 'dark')
    : (THEMES[id] ? id : 'dark');
  function apply(id) {
    const rid = resolve(id), t = THEMES[rid], root = document.documentElement;
    for (const k in t.vars) root.style.setProperty('--' + k, t.vars[k]);
    root.dataset.theme = rid; root.style.colorScheme = t.scheme;
    const m = document.querySelector('meta[name="theme-color"]'); if (m) m.setAttribute('content', t.color);
    return rid;
  }
  const saved = () => { try { return localStorage.getItem(KEY) || 'auto'; } catch (e) { return 'auto'; } };
  const save = id => { try { localStorage.setItem(KEY, id); } catch (e) {} };
  const register = (id, def) => { THEMES[id] = def; };
  const list = () => Object.keys(THEMES).map(id => ({ id, label: THEMES[id].label }));
  window.Themes = { apply, saved, save, register, list, resolve, THEMES };
  apply(saved());
  ['(prefers-color-scheme: light)', '(prefers-contrast: more)'].forEach(q => {
    const m = window.matchMedia && window.matchMedia(q);
    if (m && m.addEventListener) m.addEventListener('change', () => { if (saved() === 'auto') apply('auto'); });
  });
})();
