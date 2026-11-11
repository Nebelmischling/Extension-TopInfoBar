#!/usr/bin/env node
/**
 * Verifies this extension against a local SillyTavern checkout.
 *
 * The extension imports SillyTavern modules directly (script.js, scripts/utils.js, ...)
 * and relies on DOM ids, event types and CSS variables of the host. SillyTavern does
 * not guarantee those internals, so after updating SillyTavern run:
 *
 *   node scripts/check-st-compat.mjs "C:/path/to/SillyTavern"
 *
 * Checks:
 *  - every relative import resolves to an existing file,
 *  - every named import is actually exported by the target module,
 *  - DOM ids used via getElementById exist in the host markup,
 *  - event_types.<NAME> used by the extension still exist,
 *  - CSS variables used in style.css are defined by SillyTavern (theme variables
 *    provided at runtime are reported as notes, not failures),
 *  - manifest.json and its i18n files are valid.
 *
 * Exit codes: 0 = compatible, 1 = incompatibilities found, 2 = usage error.
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve, basename, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const extensionRoot = resolve(scriptDir, '..');
const stRoot = process.argv[2];

if (!stRoot || !existsSync(stRoot)) {
    console.error('Usage: node scripts/check-st-compat.mjs <path-to-sillytavern-checkout>');
    process.exit(2);
}

const publicDir = join(stRoot, 'public');
if (!existsSync(publicDir)) {
    console.error(`No "public" directory in "${stRoot}". Is this a SillyTavern checkout?`);
    process.exit(2);
}

/** Files of this extension that participate in the compatibility check. */
const extensionJsFiles = ['index.js', 'highlight.js'].filter(file => existsSync(join(extensionRoot, file)));
/** Virtual path of the extension inside a SillyTavern installation. */
const extensionUrlPath = posix.join('scripts', 'extensions', 'third-party', basename(extensionRoot));

const failures = [];
const notes = [];

/**
 * Records a failed check.
 * @param {string} message
 */
function fail(message) {
    failures.push(message);
}

/**
 * Resolves a relative import specifier the way the browser would, relative to the
 * extension's installation directory.
 * @param {string} specifier e.g. "../../../utils.js"
 * @returns {string} Absolute path inside the SillyTavern checkout
 */
function resolveSpecifier(specifier) {
    const urlPath = posix.normalize(posix.join(extensionUrlPath, specifier));
    return join(publicDir, ...urlPath.split('/'));
}

/**
 * Reads a file, returning null when it does not exist.
 * @param {string} path
 * @returns {string?}
 */
function readFileOrNull(path) {
    try {
        return readFileSync(path, 'utf8');
    } catch {
        return null;
    }
}

/**
 * Extracts the names a module exports.
 * @param {string} source
 * @returns {Set<string>}
 */
function parseExports(source) {
    const names = new Set();

    for (const match of source.matchAll(/export\s+(?:async\s+)?(?:function\*?|class|const|let|var)\s+([A-Za-z_$][\w$]*)/g)) {
        names.add(match[1]);
    }

    for (const match of source.matchAll(/export\s*\{([^}]*)\}/g)) {
        for (const part of match[1].split(',')) {
            const nameMatch = part.trim().match(/^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/);
            if (nameMatch) {
                names.add(nameMatch[2] ?? nameMatch[1]);
            }
        }
    }

    // `export default X` only satisfies default imports; `export * from` cannot be
    // verified without following the whole module graph.
    if (/export\s+default\s/.test(source)) {
        names.add('default');
    }
    if (/export\s*\*\s*from/.test(source)) {
        names.add('*');
    }

    return names;
}

/**
 * Extracts the imported bindings of a module.
 * @param {string} source
 * @returns {Array<{specifier: string, names: string[]}>}
 */
function parseImports(source) {
    const imports = [];
    const importPattern = /import\s+(?:([\w$*]+)\s*,?\s*)?(?:\{([^}]*)\})?\s*from\s*['"]([^'"]+)['"]/g;

    for (const match of source.matchAll(importPattern)) {
        const defaultBinding = match[1];
        const namedBindings = match[2];
        const specifier = match[3];
        const names = [];

        if (defaultBinding && defaultBinding !== '*') {
            names.push('default');
        }
        if (namedBindings) {
            for (const part of namedBindings.split(',')) {
                const nameMatch = part.trim().match(/^([A-Za-z_$][\w$]*)(?:\s+as\s+[A-Za-z_$][\w$]*)?$/);
                if (nameMatch) {
                    names.push(nameMatch[1]);
                }
            }
        }

        imports.push({ specifier, names });
    }

    return imports;
}

/** Collects the ids declared in an HTML document. @param {string} html @returns {Set<string>} */
function parseHtmlIds(html) {
    const ids = new Set();
    for (const match of html.matchAll(/\bid=["']([^"'{}]+)["']/g)) {
        ids.add(match[1]);
    }
    return ids;
}

/** Recursively lists files below a directory. @param {string} root @param {string} extension @returns {string[]} */
function listFiles(root, extension) {
    const files = [];
    for (const entry of readdirSync(root, { withFileTypes: true })) {
        const path = join(root, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === 'node_modules' || entry.name.startsWith('.')) {
                continue;
            }
            files.push(...listFiles(path, extension));
        } else if (entry.isFile() && entry.name.endsWith(extension)) {
            files.push(path);
        }
    }
    return files;
}

// --- 1. Imports and exported symbols -------------------------------------------------
const extensionSources = new Map();
for (const file of extensionJsFiles) {
    const source = readFileOrNull(join(extensionRoot, file));
    if (!source) {
        fail(`Extension file missing: ${file}`);
        continue;
    }
    extensionSources.set(file, source);
}

for (const [file, source] of extensionSources) {
    for (const { specifier, names } of parseImports(source)) {
        if (!specifier.startsWith('.')) {
            continue;
        }

        // Imports that stay inside the extension directory are the extension's own files.
        const virtualTarget = posix.normalize(posix.join(extensionUrlPath, specifier));
        if (virtualTarget.startsWith(`${extensionUrlPath}/`)) {
            continue;
        }

        const targetPath = resolveSpecifier(specifier);
        const targetSource = readFileOrNull(targetPath);

        if (!targetSource) {
            fail(`${file}: import "${specifier}" -> ${targetPath} does not exist in SillyTavern`);
            continue;
        }

        const exports = parseExports(targetSource);
        if (exports.has('*')) {
            continue;
        }

        for (const name of names) {
            if (!exports.has(name)) {
                fail(`${file}: "${name}" is imported from "${specifier}" but no longer exported by SillyTavern`);
            }
        }
    }
}

// --- 2. DOM ids ----------------------------------------------------------------------
const indexHtml = readFileOrNull(join(publicDir, 'index.html')) ?? '';
const htmlIds = parseHtmlIds(indexHtml);

// Settings templates of built-in extensions (e.g. Connection Profiles) are rendered
// into the page later, so their ids are gathered separately.
for (const file of listFiles(join(publicDir, 'scripts', 'extensions'), '.html')) {
    if (file.includes(`${join('extensions', 'third-party')}`) && !file.startsWith(join(publicDir, 'scripts', 'extensions', 'third-party', 'Extension-TopInfoBar'))) {
        continue;
    }
    for (const id of parseHtmlIds(readFileSync(file, 'utf8'))) {
        htmlIds.add(id);
    }
}

for (const [file, source] of extensionSources) {
    for (const match of source.matchAll(/getElementById\(['"]([^'"]+)['"]\)/g)) {
        // Ids created by this extension itself are not part of SillyTavern's markup.
        if (match[1].startsWith('extension')) {
            continue;
        }
        if (!htmlIds.has(match[1])) {
            fail(`${file}: DOM id "#${match[1]}" not found in SillyTavern markup`);
        }
    }
}

// --- 3. Event types ------------------------------------------------------------------
// The top bar generation preset dropdown mirrors SillyTavern's #settings_preset* selects.
const presetSelectorsSource = extensionSources.get('index.js') ?? '';
const presetSelectorMap = /const generationPresetSelectors = \{([\s\S]*?)\};/.exec(presetSelectorsSource);
if (presetSelectorMap) {
    for (const match of presetSelectorMap[1].matchAll(/['"]#([\w-]+)['"]/g)) {
        if (!htmlIds.has(match[1])) {
            fail(`index.js: generation preset selector "#${match[1]}" not found in SillyTavern markup`);
        }
    }
} else {
    notes.push('generationPresetSelectors not found in index.js; preset anchor check skipped');
}

const eventsSource = readFileOrNull(join(publicDir, 'scripts', 'events.js')) ?? '';
const eventNames = new Set([...eventsSource.matchAll(/^\s*([A-Z_]+):\s*['"]/gm)].map(match => match[1]));

for (const [file, source] of extensionSources) {
    for (const match of source.matchAll(/event_types\.([A-Z_]+)/g)) {
        if (!eventNames.has(match[1])) {
            fail(`${file}: event_types.${match[1]} no longer exists in SillyTavern`);
        }
    }
}

// --- 4. CSS variables ----------------------------------------------------------------
const styleCss = readFileOrNull(join(extensionRoot, 'style.css')) ?? '';
const stCssSources = [
    readFileOrNull(join(publicDir, 'style.css')) ?? '',
    ...(existsSync(join(publicDir, 'css')) ? listFiles(join(publicDir, 'css'), '.css').map(file => readFileSync(file, 'utf8')) : []),
].join('\n');

const definedCssVars = new Set([...stCssSources.matchAll(/--([\w-]+)\s*:/g)].map(match => match[1]));

for (const match of styleCss.matchAll(/var\(--([\w-]+)/g)) {
    const name = match[1];
    if (definedCssVars.has(name) || name.startsWith('SmartTheme') || name.startsWith('topBarSearch') || name === 'top-info-bar-space') {
        continue;
    }
    notes.push(`CSS variable --${name} is not defined by SillyTavern base styles (a theme may provide it)`);
}

// --- 5. Manifest ---------------------------------------------------------------------
let manifest = null;
try {
    manifest = JSON.parse(readFileSync(join(extensionRoot, 'manifest.json'), 'utf8'));
} catch (error) {
    fail(`manifest.json is not valid JSON: ${error.message}`);
}

if (manifest) {
    for (const key of ['display_name', 'js', 'css', 'version']) {
        if (!manifest[key]) {
            fail(`manifest.json is missing "${key}"`);
        }
    }

    for (const file of [manifest.js, manifest.css]) {
        if (file && !existsSync(join(extensionRoot, file))) {
            fail(`manifest.json references "${file}", which does not exist`);
        }
    }

    for (const [locale, file] of Object.entries(manifest.i18n ?? {})) {
        try {
            JSON.parse(readFileSync(join(extensionRoot, file), 'utf8'));
        } catch (error) {
            fail(`i18n file for "${locale}" (${file}) is missing or invalid: ${error.message}`);
        }
    }
}

// --- Report --------------------------------------------------------------------------
console.log(`Checking ${basename(extensionRoot)} against SillyTavern at ${stRoot}`);
console.log(`  extension path inside ST: public/${extensionUrlPath}/`);
console.log(`  SillyTavern version: ${readFileOrNull(join(stRoot, 'package.json'))?.match(/"version":\s*"([^"]+)"/)?.[1] ?? 'unknown'}`);
console.log('');

for (const note of notes) {
    console.log(`NOTE ${note}`);
}

if (failures.length === 0) {
    console.log(`OK   No incompatibilities found (${notes.length} note(s)).`);
    process.exit(0);
}

for (const failure of failures) {
    console.log(`FAIL ${failure}`);
}
console.log(`\n${failures.length} incompatibility(ies) found.`);
process.exit(1);
