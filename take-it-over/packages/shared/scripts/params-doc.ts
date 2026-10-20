import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderParamsDoc } from '../src/params-doc';

const target = fileURLToPath(new URL('../../../docs/game-parameters.md', import.meta.url));
writeFileSync(target, renderParamsDoc());
console.log(`wrote ${target}`);
