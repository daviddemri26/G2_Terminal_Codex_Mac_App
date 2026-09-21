import { readFileSync, writeFileSync } from 'node:fs';

const sdkRoot = new URL('../node_modules/@evenrealities/even_hub_sdk/', import.meta.url);
const metadata = JSON.parse(readFileSync(new URL('package.json', sdkRoot), 'utf8'));
if (metadata.version !== '0.0.14' || metadata.license !== 'MIT') {
  throw new Error('Review the SDK notices before changing its pinned version.');
}
const license = readFileSync(new URL('LICENSE', sdkRoot), 'utf8');
const notice = `Even Terminal for Codex Mac App Guide includes @evenrealities/even_hub_sdk ${metadata.version}.\n\n` +
  `The following notice is copied verbatim from the installed, locked npm package.\n` +
  `It applies to the SDK; it does not grant a license to this project's own code.\n\n${license}`;
writeFileSync(new URL('../dist/THIRD_PARTY_NOTICES.txt', import.meta.url), notice);
