import { generateKeyPairSync } from 'node:crypto';
import forge from 'node-forge';

/**
 * A self-signed certificate for local TLS test servers, generated on first
 * use (so no private key is checked in) and shared by every test in the
 * run. Node's crypto makes the key; node-forge only builds and signs the
 * certificate, since Node has no API for that. Not in the published build
 * (tsconfig.build.json excludes src/test).
 */
let cached: { key: string; cert: string } | undefined;

export function selfSignedCertificate(): { key: string; cert: string } {
  if (cached) return cached;
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  const cert = forge.pki.createCertificate();
  cert.publicKey = forge.pki.publicKeyFromPem(publicKey);
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date(Date.now() - 60_000);
  cert.validity.notAfter = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const subject = [{ name: 'commonName', value: 'localhost' }];
  cert.setSubject(subject);
  cert.setIssuer(subject);
  cert.sign(forge.pki.privateKeyFromPem(privateKey), forge.md.sha256.create());
  cached = { key: privateKey, cert: forge.pki.certificateToPem(cert) };
  return cached;
}
