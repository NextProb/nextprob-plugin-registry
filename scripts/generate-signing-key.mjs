import crypto from 'node:crypto';
import fs from 'node:fs';
import { keyId } from './lib/sign.mjs';

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) throw new Error(`Unexpected argument: ${token}`);
    let name = token.slice(2);
    let value;
    const equals = name.indexOf('=');
    if (equals >= 0) {
      value = name.slice(equals + 1);
      name = name.slice(0, equals);
    }
    if (!['private', 'public'].includes(name)) throw new Error(`Unknown option: --${name}`);
    if (value === undefined) {
      index += 1;
      if (index >= argv.length) throw new Error(`--${name} requires a value`);
      value = argv[index];
    }
    options[name] = value;
  }
  if (!options.private || !options.public) throw new Error('--private and --public are required');
  return options;
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' });
  let privateWritten = false;
  try {
    fs.writeFileSync(options.private, privatePem, { flag: 'wx', mode: 0o600 });
    privateWritten = true;
    fs.writeFileSync(options.public, publicPem, { flag: 'wx', mode: 0o644 });
  } catch (error) {
    if (privateWritten) fs.rmSync(options.private, { force: true });
    if (error.code === 'EEXIST') throw new Error('Refusing to overwrite an existing signing key');
    throw error;
  }
  process.stdout.write(`keyId=${keyId(publicKey)}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`error: ${error.message}\n`);
  process.exitCode = 1;
}
