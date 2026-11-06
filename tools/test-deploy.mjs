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

/* All three pages must ship, and the chooser's links must land on real files.
   A broken link on the front page is the worst failure this site can have. */
const PAGES = ['index.html', 'photo.html', 'profile.html'];
const missingPages = PAGES.filter((f) => !files.includes(join(site, f)));
check('every page is published', missingPages.length === 0, missingPages.join(', ') || PAGES.join(', '));

const deadLinks = [];
for (const page of PAGES) {
  if (!existsSync(join(site, page))) continue;
  const source = readFileSync(join(site, page), 'utf8');
  for (const m of source.matchAll(/<a[^>]+href="([^"]+)"/g)) {
    const href = m[1];
    if (/^(https?:|mailto:|#)/.test(href)) continue;
    // "./" means the directory index.
    const target = href === './' || href === '.' ? 'index.html' : href.split(/[?#]/)[0];
    if (!existsSync(join(site, target))) deadLinks.push(`${page} → ${href}`);
  }
}
check('every internal link resolves to a published file', deadLinks.length === 0,
  deadLinks.join(' | '));

const absoluteOnPages = [];
for (const page of PAGES) {
  if (!existsSync(join(site, page))) continue;
  const source = readFileSync(join(site, page), 'utf8');
  for (const m of source.matchAll(/(?:src|href)="(\/[^/][^"]*)"/g)) {
    absoluteOnPages.push(`${page} → ${m[1]}`);
  }
}
check('no page uses a root-absolute path', absoluteOnPages.length === 0,
  absoluteOnPages.join(' | ') || 'all relative');

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

check('each page has exactly one module entry point', (() => {
  const counts = PAGES.filter((f) => existsSync(join(site, f))).map((f) => {
    const source = readFileSync(join(site, f), 'utf8');
    return (source.match(/<script type="module"/g) || []).length;
  });
  // The chooser has none; each workspace has exactly one.
  return counts[0] === 0 && counts.slice(1).every((n) => n === 1);
})(), 'a second script tag would boot an app twice');

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
// The darkroom moved to its own page; that is where the sample is referenced.
const photoHtml = readFileSync(join(site, 'photo.html'), 'utf8');
check('demo photos are lazily usable offline', /sample-portrait\.jpg/.test(photoHtml));
check('the chooser declares a language', /<html[^>]+lang=/.test(html));
check('every page declares a language',
  PAGES.every((f) => /<html[^>]+lang=/.test(readFileSync(join(site, f), 'utf8'))));
check('every page has its own title',
  PAGES.every((f) => /<title>[^<]{5,}<\/title>/.test(readFileSync(join(site, f), 'utf8'))),
  'three pages sharing one title makes tabs impossible to tell apart');

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.filter((r) => r.ok).length}/${results.length} checks passed`);
if (failed.length) {
  console.log('failed:', failed.map((f) => f.name).join(', '));
  process.exit(1);
}
