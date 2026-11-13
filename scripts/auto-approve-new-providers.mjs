import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

import yaml from 'js-yaml';

export const PROVIDERS_FILE = 'packages/providers/providers.yaml';
export const SCOPES_FILE = 'packages/providers/providers.scopes.yaml';
export const HOOKS_INDEX_FILE = 'packages/server/lib/hooks/connection/index.ts';
const LOGOS_DIR = 'packages/webapp/public/images/template-logos/';
const HOOKS_DIR = 'packages/server/lib/hooks/connection/providers/';
const HOOK_SCRIPTS = ['post-connection', 'credentials-verification'];
const HOOK_FILES = new Set([...HOOK_SCRIPTS.map((name) => `${name}.ts`), 'types.ts']);
const HOOK_EXPORT = new RegExp(`^export \\{ default as \\w+ \\} from '\\./providers/([a-z0-9-]+)/(${HOOK_SCRIPTS.join('|')})\\.js';$`);

export function hookProvider(path) {
    if (!path.startsWith(HOOKS_DIR)) {
        return null;
    }
    const parts = path.slice(HOOKS_DIR.length).split('/');
    return parts.length === 2 && HOOK_FILES.has(parts[1]) ? parts[0] : null;
}

export function checkChangedFiles(files) {
    const reasons = [];
    for (const { status, path } of files) {
        if (path.startsWith('docs/')) {
            continue;
        }
        if (path === PROVIDERS_FILE || path === SCOPES_FILE) {
            if (status !== 'M') {
                reasons.push(`${path} must be modified, not ${status}`);
            }
            continue;
        }
        if (path.startsWith(LOGOS_DIR)) {
            if (status !== 'A') {
                reasons.push(`${path}: only new logos are allowed (status ${status})`);
            }
            continue;
        }
        if (path === HOOKS_INDEX_FILE) {
            if (status !== 'M') {
                reasons.push(`${path} must be modified, not ${status}`);
            }
            continue;
        }
        if (hookProvider(path)) {
            if (status !== 'A') {
                reasons.push(`${path}: only new hook files are allowed (status ${status})`);
            }
            continue;
        }
        reasons.push(`${path} is outside the allowed paths`);
    }
    return reasons;
}

/**
 * Compares two versions of a top-level map of providers.
 * @param {string} baseText - file content on the base branch
 * @param {string} headText - file content on the PR
 * @param {string} label - file name used in messages
 * @returns {{ added: string[], reasons: string[] }}
 */
export function compareProviderMaps(baseText, headText, label) {
    const base = yaml.load(baseText) ?? {};
    const head = yaml.load(headText) ?? {};
    if (!isPlainObject(base) || !isPlainObject(head)) {
        return { added: [], reasons: [`${label} is not a map of providers`] };
    }

    const reasons = [];
    for (const key of Object.keys(base)) {
        if (!Object.hasOwn(head, key)) {
            reasons.push(`${label}: existing provider "${key}" was removed`);
        } else if (!isDeepStrictEqual(base[key], head[key])) {
            reasons.push(`${label}: existing provider "${key}" was changed`);
        }
    }
    const added = Object.keys(head).filter((key) => !Object.hasOwn(base, key));
    return { added, reasons };
}

export function compareHooksIndex(baseText, headText, added) {
    const remaining = new Map();
    for (const line of headText.split('\n')) {
        remaining.set(line, (remaining.get(line) ?? 0) + 1);
    }

    const reasons = [];
    for (const line of baseText.split('\n')) {
        const count = remaining.get(line) ?? 0;
        if (count === 0) {
            reasons.push(`${HOOKS_INDEX_FILE}: existing line was changed or removed: ${line}`);
        } else {
            remaining.set(line, count - 1);
        }
    }

    for (const [line, count] of remaining) {
        if (count === 0 || line.trim() === '') {
            continue;
        }
        const match = HOOK_EXPORT.exec(line);
        if (!match) {
            reasons.push(`${HOOKS_INDEX_FILE}: unexpected line: ${line}`);
        } else if (!added.includes(match[1])) {
            reasons.push(`${HOOKS_INDEX_FILE}: export for "${match[1]}", which this PR doesn't add`);
        }
    }
    return reasons;
}

export function evaluate({ files, readBase, readHead }) {
    const reasons = checkChangedFiles(files);
    const changed = new Set(files.map((f) => f.path));

    let added = [];
    if (changed.has(PROVIDERS_FILE)) {
        const result = compareProviderMaps(readBase(PROVIDERS_FILE), readHead(PROVIDERS_FILE), PROVIDERS_FILE);
        added = result.added;
        reasons.push(...result.reasons);
    }
    if (changed.has(SCOPES_FILE)) {
        reasons.push(...compareProviderMaps(readBase(SCOPES_FILE), readHead(SCOPES_FILE), SCOPES_FILE).reasons);
    }
    if (added.length === 0) {
        reasons.push(`no new provider added to ${PROVIDERS_FILE}`);
    }

    for (const { path } of files) {
        const provider = hookProvider(path);
        if (provider && !added.includes(provider)) {
            reasons.push(`${path}: hook for "${provider}", which this PR doesn't add`);
        }
    }
    if (changed.has(HOOKS_INDEX_FILE)) {
        reasons.push(...compareHooksIndex(readBase(HOOKS_INDEX_FILE), readHead(HOOKS_INDEX_FILE), added));
    }

    return { approve: reasons.length === 0, added, reasons };
}

function isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function git(...args) {
    return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function parseNameStatus(output) {
    return output
        .split('\n')
        .filter(Boolean)
        .map((line) => {
            const parts = line.split('\t');
            // Renames and copies list the old and new path; the new path is the one that ends up in the repo.
            return { status: parts[0][0], path: parts[parts.length - 1] };
        });
}

function main() {
    const baseSha = process.argv[2];
    if (!baseSha) {
        console.error('Usage: node scripts/auto-approve-new-providers.mjs <base-sha>');
        process.exit(2);
    }

    const files = parseNameStatus(git('diff', '--name-status', `${baseSha}...HEAD`));
    const result = evaluate({
        files,
        readBase: (path) => git('show', `${baseSha}:${path}`),
        readHead: (path) => git('show', `HEAD:${path}`)
    });

    if (result.approve) {
        console.log(`Only new providers added: ${result.added.join(', ')}`);
    } else {
        console.log('Not auto-approving:');
        for (const reason of result.reasons) {
            console.log(`- ${reason}`);
        }
    }

    if (process.env['GITHUB_OUTPUT']) {
        appendFileSync(process.env['GITHUB_OUTPUT'], `approve=${result.approve}\nadded=${result.added.join(', ')}\n`);
    }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    main();
}
