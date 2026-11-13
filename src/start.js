// Point d'entrée de l'application : vérifie Node.js avant de charger le reste.
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  console.error(`\n  Node.js ${process.versions.node} est trop ancien : il faut la version 22.13 ou plus récente.`
    + "\n  Lancez l'application avec le fichier Lancer-Windows.bat ou Lancer-Mac.command :"
    + '\n  il télécharge automatiquement une version adaptée, sans rien installer sur le système.\n');
  process.exit(1);
}

// node:sqlite est encore marqué « expérimental » : on n'affiche pas cet avertissement (les autres restent visibles).
process.removeAllListeners('warning');
process.on('warning', (w) => { if (w.name !== 'ExperimentalWarning') console.warn(`${w.name}: ${w.message}`); });

try {
  await import('node:sqlite');
} catch (e) {
  console.error(`\n  Le module node:sqlite n'est pas disponible dans Node.js ${process.versions.node} (${e.message}).`
    + '\n  Installez Node.js 22.13 ou plus récent, ou utilisez le fichier Lancer-… qui le fait pour vous.\n');
  process.exit(1);
}

await import('./server.js');
