// Rapporteur de tests pour la CI GitHub : annotation « ::error » lisible pour chaque test en échec.
import './_unit.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { annotation, failureMessage } from './reporter-github.js';

test('annotation GitHub : fichier, ligne, titre et message échappés', () => {
  const error = { cause: new Error('coup 3... Cf6 : erreur au lieu de gaffe\n+ actual\n- expected') };
  const line = annotation({ name: 'mat : gaffe, ou pas', file: path.join(process.cwd(), 'test', 'x.test.js'), line: 12, error });
  assert.equal(line, '::error file=test/x.test.js,line=12,title=Test en échec %3A mat %3A gaffe%2C ou pas::coup 3... Cf6 %3A erreur au lieu de gaffe%0A+ actual%0A- expected\n'.replace('Cf6 %3A', 'Cf6 :'));
  assert.equal(failureMessage(new Error('a\n\n\nb')), 'a\nb', 'lignes vides retirées');
  assert.match(annotation({ name: 't', error: 'texte' }), /^::error title=Test en échec %3A t::texte\n$/);
});
