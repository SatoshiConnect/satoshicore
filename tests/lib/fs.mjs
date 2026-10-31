import { readdirSync } from 'node:fs';
import { join } from 'node:path';

export function walkSync(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walkSync(join(dir, e.name)) : [join(dir, e.name)]
  );
}
