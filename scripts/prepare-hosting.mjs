import {
    cp,
    mkdir,
    readFile,
    readdir,
    writeFile,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';

const hostingDist = resolve('dist');
const marketingDist = resolve('../hominode/dist');

// 1. Preserve the freshly built Resident SPA before replacing root index.html.
await mkdir(join(hostingDist, '__resident_app'), { recursive: true });

const residentIndex = await readFile(
    join(hostingDist, 'index.html'),
    'utf8',
);

await writeFile(
    join(hostingDist, '__resident_app', 'index.html'),
    residentIndex,
);

// 2. Merge the CURRENT Hominode portfolio build into the hosting root.
const marketingFiles = await readdir(marketingDist);

for (const entry of marketingFiles) {
    await cp(
        join(marketingDist, entry),
        join(hostingDist, entry),
        {
            recursive: true,
            force: true,
        },
    );
}

console.log('Hosting bundle prepared:');
console.log('  /                    → Hominode portfolio');
console.log('  /resident            → Resident community finder');
console.log('  /<community-slug>/   → Resident application');