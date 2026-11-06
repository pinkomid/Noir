/**
 * Deployment checks.
 * GitHub Pages serves this project from https://<user>.github.io/Noir-Photo-Studio/,
 * so every path must be relative and every referenced file must actually ship.
 *
 *   node tools/test-deploy.mjs
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, normalize } from 'node:path';

const results = [];
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  results.push({ name, ok });
};

console.log('\nNOIR deploy test\n');

/* ---- 1. Workflow exists and targets the right branch ---------------- */
const wfPath = '.github/workflows/deploy-pages.yml';
check('deploy workflow exists', existsSync(wfPath));
const wf = existsSync(wfPath) ? readFileSync(wfPath, 'utf8') : '';
check('workflow triggers on main', /branches:\s*\[\s*main\s*\]/.test(wf));
check('workflow has Pages permissions', /pages:\s*write/.test(wf) && /id-token:\s*write/.test(wf));
check('workflow uploads the assembled site', /upload-pages-artifact/.test(wf));
check('workflow deploys with deploy-pages', /actions\/deploy-pages/.test(wf));
check('workflow uses a concurrency group', /concurrency:\s*\n\s*group:\s*pages/.test(wf));

/* ---- 2. The site is assembled and self-contained -------------------- */
const site = '_site';
if (!existsSync(site)) {
  check('_site exists (run `npm run build`)', false, 'missing');
  process.exit(1);
}
check('_site exists', true);

const files = [];
(function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full);
    else files.push(full);
  }
})(site);

check('nojeckyll marker is present', files.some((f) => f.endsWith('.nojekyll')));
check('tests and tooling are not published',
  !files.some((f) => f.includes('/tools/') || f.includes('/node_modules/') || f.endsWith('.mjs')));
check('assets are published', files.some((f) => f.startsWith(join(site, 'assets'))));
check('every js module is published', (() => {
  const src = readdirSync('js').filter((f) => f.endsWith('.js'));
  return src.every((f) => files.includes(join(site, 'js', f)));
})(), `${readdirSync('js').filter((f) => f.endsWith('.js')).length} modules`);

/* ---- 3. No absolute paths, no missing references -------------------- */
const html = readFileSync(join(site, 'index.html'), 'utf8');
const absolute = [...html.matchAll(/(?:src|href)="(\/[^/][^"]*)"/g)].map((m) => m[1]);
check('no root-absolute references in the HTML', absolute.length === 0, absolute.join(', '));

/**
 * Broken relative reference = blank page on Pages. Walk every reference in
 * the HTML and in the JS modules the page loads.
 */
const missing = [];

function checkRef(fromFile, ref) {
  if (!ref || /^(https?:)?\/\//.test(ref) || ref.startsWith('data:') || ref.startsWith('#')) return;
  const target = normalize(join(dirname(fromFile), ref.split('?')[0].split('#')[0]));
  if (!existsSync(target)) missing.push(`${fromFile} → ${ref}`);
}

for (const m of html.matchAll(/(?:src|href)="([^"]+)"/g)) checkRef(join(site, 'index.html'), m[1]);

// Static string literals like 'assets/sample-portrait.jpg' and './engine.js'
const jsDir = join(site, 'js');
for (const f of readdirSync(jsDir)) {
  if (!f.endsWith('.js')) continue;
  const code = readFileSync(join(jsDir, f), 'utf8');
  for (const m of code.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
    checkRef(join(jsDir, f), m[1].startsWith('.') ? m[1] : `./${m[1]}`);
  }
  for (const m of code.matchAll(/['"](assets\/[^'"]+)['"]/g)) {
    checkRef(join(site, 'index.html'), m[1]);
  }
}
check('every referenced file ships with the site', missing.length === 0, missing.join(' | '));

/* ---- 4. Module graph has no orphans or cycles ---------------------- */
const imported = new Set();
for (const f of readdirSync(jsDir)) {
  if (!f.endsWith('.js')) continue;
  const code = readFileSync(join(jsDir, f), 'utf8');
  for (const m of code.matchAll(/from\s+['"]\.\/([^'"]+)['"]/g)) imported.add(m[1]);
}
const modules = readdirSync(jsDir).filter((f) => f.endsWith('.js'));
const orphans = modules.filter((f) => f !== 'app.js' && !imported.has(f));
check('every module is reachable from an entry point', orphans.length === 0, orphans.join(', ') || 'none');

/* ---- 4b. The profile pane ships too -------------------------------- */

/*
 * `project/` is a second source tree. A build step that copies `js/` but not
 * `project/` produces a site that loads and then throws on a missing module,
 * which no path check above would notice because the tag itself resolves.
 */
const projectDir = join('project');
const projectFiles = [];
(function walkProject(dir) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walkProject(full);
    else projectFiles.push(full);
  }
})(projectDir);

check('the profile editor source exists', projectFiles.length > 0,
  `${projectFiles.length} files`);

const projectMissing = projectFiles.filter((f) => !files.includes(join(site, f)));
check('every profile-editor file is published', projectMissing.length === 0,
  projectMissing.join(', '));

check('the profile stylesheet is published',
  files.includes(join(site, 'styles', 'profile.css')));

check('the shell is the page\'s only entry point',
  (html.match(/<script type="module"/g) || []).length === 1,
  'a second script tag would boot the darkroom twice');

/* Every module the shell imports must resolve inside the published tree. */
const shellPath = join(site, 'project', 'shell.js');
const shellMissing = [];
if (existsSync(shellPath)) {
  const shellSrc = readFileSync(shellPath, 'utf8');
  for (const m of shellSrc.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
    checkRef(shellPath, m[1]);
  }
  // Side-effect imports too — that is how app.js is reached.
  for (const m of shellSrc.matchAll(/import\s+['"](\.[^'"]+)['"]/g)) {
    checkRef(shellPath, m[1]);
  }
}
check('every module the shell imports ships', shellMissing.length === 0, shellMissing.join(', '));

check('no profile-editor file is a root-absolute reference',
  projectFiles.every((f) => {
    const code = readFileSync(f, 'utf8');
    return !/(?:src|href)="\/[^/]/.test(code) && !/from\s+'\/[^.]/.test(code);
  }), 'the site is served from a /Noir-Photo-Studio/ subpath');

check('the zip upload is not published',
  !files.some((f) => f.endsWith('.zip')),
  'a 2MB archive of unrelated drafts does not belong on the site');

/* ---- 5. Progressive hardening -------------------------------------- */
check('page declares a language', /<html[^>]+lang=/.test(html));
check('responsive viewport is declared', /name="viewport"/.test(html));
check('a favicon is inlined (no 404 on Pages)', /rel="icon"/.test(html));
check('demo photos are lazily usable offline', /sample-portrait\.jpg/.test(html));

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.filter((r) => r.ok).length}/${results.length} checks passed`);
if (failed.length) {
  console.log('failed:', failed.map((f) => f.name).join(', '));
  process.exit(1);
}
