// Rapporteur de tests pour GitHub Actions (utilisé seulement par la CI, voir .github/workflows/ci.yml) : chaque test
// qui échoue devient une annotation « ::error » avec son nom et son message. Les annotations s'affichent sur la page
// de la CI et se lisent sans compte GitHub, contrairement au journal complet.
import path from 'node:path';

// Échappement des commandes GitHub : % \r \n dans le message, et aussi : et , dans les propriétés.
const escData = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const escProp = (s) => escData(s).replace(/:/g, '%3A').replace(/,/g, '%2C');

/** Message lisible d'un échec (l'erreur d'origine est dans « cause »), limité à quelques lignes. */
export function failureMessage(error) {
  const e = error?.cause ?? error;
  const text = e?.message ?? String(e ?? 'échec');
  return text.split('\n').filter((l) => l.trim()).slice(0, 8).join('\n');
}

/** Ligne d'annotation GitHub pour un test en échec. */
export function annotation({ name, file, line, error }) {
  const rel = file ? path.relative(process.cwd(), file.startsWith('file:') ? new URL(file).pathname.replace(/^\/([A-Za-z]:)/, '$1') : file).split(path.sep).join('/') : '';
  const props = [rel && `file=${escProp(rel)}`, rel && line && `line=${line}`, `title=${escProp(`Test en échec : ${name}`)}`].filter(Boolean).join(',');
  return `::error ${props}::${escData(failureMessage(error))}\n`;
}

export default async function* githubAnnotations(source) {
  for await (const event of source) {
    if (event.type !== 'test:fail') continue;
    const d = event.data;
    // Un fichier qui échoue en entier (erreur au chargement) est signalé aussi ; ses tests en échec le sont un par un.
    if (d.details?.error?.failureType === 'subtestsFailed') continue;
    yield annotation({ name: d.name, file: d.file, line: d.line, error: d.details?.error });
  }
}
