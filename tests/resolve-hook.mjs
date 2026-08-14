import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';

/**
 * Lets `node --test` run the app's TypeScript directly.
 *
 * Source files use extensionless imports and the `@/` alias, both of which the
 * bundler understands and Node's ESM resolver does not. This bridges the two so
 * tests exercise the real modules — rather than adding a test framework, which
 * the stack list (§4.1) does not include.
 */

const projectRoot = resolvePath(dirname(fileURLToPath(import.meta.url)), '..');
const CANDIDATE_SUFFIXES = ['.ts', '.tsx', '/index.ts', '/index.tsx'];

function firstExisting(basePath) {
  for (const suffix of CANDIDATE_SUFFIXES) {
    const candidate = basePath + suffix;
    if (existsSync(candidate)) return pathToFileURL(candidate).href;
  }
  return null;
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    const isAlias = specifier.startsWith('@/');
    const isRelative = specifier.startsWith('./') || specifier.startsWith('../');

    if ((isAlias || isRelative) && !/\.[cm]?[jt]sx?$/.test(specifier)) {
      const basePath = isAlias
        ? resolvePath(projectRoot, specifier.slice(2))
        : resolvePath(dirname(fileURLToPath(context.parentURL)), specifier);

      const url = firstExisting(basePath);
      // Format is left unset so Node infers it from the extension and applies
      // its own TypeScript stripping.
      if (url) return { url, shortCircuit: true };
    }

    if (isAlias) {
      const url = pathToFileURL(resolvePath(projectRoot, specifier.slice(2))).href;
      return { url, shortCircuit: true };
    }

    return nextResolve(specifier, context);
  },
});
