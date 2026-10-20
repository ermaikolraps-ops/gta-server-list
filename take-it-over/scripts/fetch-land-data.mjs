#!/usr/bin/env node
// Downloads the default land mask: Natural Earth 1:10m land + lakes (public domain).
// Works on Windows, macOS, Linux and inside Docker. For production-grade
// coastlines use OSM land polygons instead (see docs/maps-and-land.md).
import { createWriteStream, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
const base = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson';
mkdirSync(dir, { recursive: true });
for (const name of ['ne_10m_land', 'ne_10m_lakes']) {
  const target = join(dir, `${name}.geojson`);
  if (existsSync(target) && statSync(target).size > 0) {
    console.log(`${name}: already present`);
    continue;
  }
  console.log(`downloading ${name}…`);
  const res = await fetch(`${base}/${name}.geojson`);
  if (!res.ok || !res.body) throw new Error(`download failed: ${res.status} ${res.statusText}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(`${target}.tmp`));
  renameSync(`${target}.tmp`, target);
}
console.log(`land data ready in ${dir}`);
