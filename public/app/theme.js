// Thème de l'interface : automatique (celui du système), clair ou sombre. Le choix est mémorisé dans le navigateur.
// Les fonctions reçoivent le document et le stockage en paramètres : elles sont testées sans navigateur.

export const THEMES = ['auto', 'light', 'dark'];
export const THEME_KEY = 'theme';
export const THEME_LABEL = { auto: 'automatique (comme le système)', light: 'clair', dark: 'sombre' };
export const THEME_ICON = { auto: '◐', light: '☀', dark: '☾' };

/** Thème mémorisé ; « auto » s'il n'y en a pas ou si le stockage est indisponible. */
export function storedTheme(storage) {
  try {
    const v = storage?.getItem(THEME_KEY);
    return THEMES.includes(v) ? v : 'auto';
  } catch {
    return 'auto';
  }
}

/** Thème suivant au clic : automatique → clair → sombre → automatique. */
export const nextTheme = (choice) => THEMES[(THEMES.indexOf(choice) + 1) % THEMES.length];

/** Thème réellement affiché. */
export const effectiveTheme = (choice, systemDark) => (choice === 'auto' ? (systemDark ? 'dark' : 'light') : choice);

/** Applique un choix sur la page (attribut data-theme de <html>) et le mémorise. */
export function applyTheme(doc, storage, choice) {
  const c = THEMES.includes(choice) ? choice : 'auto';
  if (c === 'auto') doc.documentElement.removeAttribute('data-theme');
  else doc.documentElement.setAttribute('data-theme', c);
  try {
    if (c === 'auto') storage?.removeItem(THEME_KEY);
    else storage?.setItem(THEME_KEY, c);
  } catch { /* stockage indisponible : le choix vaut pour cette page seulement */ }
  return c;
}

/** Bouton de la barre du haut. */
export function themeButton(btn, doc = document, storage = globalThis.localStorage) {
  let choice = storedTheme(storage);
  const paint = () => {
    btn.textContent = THEME_ICON[choice];
    btn.title = `Thème ${THEME_LABEL[choice]} : cliquez pour changer`;
    btn.setAttribute('aria-label', btn.title);
  };
  applyTheme(doc, storage, choice);
  paint();
  btn.addEventListener('click', () => { choice = applyTheme(doc, storage, nextTheme(choice)); paint(); });
}
