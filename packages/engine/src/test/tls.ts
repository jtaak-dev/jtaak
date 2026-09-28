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

export interface TestPki {
  /** The authority that signed the server's and the client's certificates (PEM). */
  ca: string;
  server: { key: string; cert: string };
  client: { key: string; cert: string; pfx: Buffer; passphrase: string };
}

let cachedPki: TestPki | undefined;

/**
 * A certificate authority with a server certificate (for `localhost` and
 * 127.0.0.1) and a client certificate signed by it, for mutual TLS tests;
 * the client's also as a PKCS #12 file with a passphrase. Generated on first
 * use, like `selfSignedCertificate`.
 */
export function testPki(): TestPki {
  if (cachedPki) return cachedPki;
  const keys = () => forge.pki.rsa.generateKeyPair(2048);
  const caKeys = keys();
  const validity = (cert: forge.pki.Certificate, serial: string) => {
    cert.serialNumber = serial;
    cert.validity.notBefore = new Date(Date.now() - 60_000);
    cert.validity.notAfter = new Date(Date.now() + 24 * 60 * 60 * 1000);
  };
  const caCert = forge.pki.createCertificate();
  caCert.publicKey = caKeys.publicKey;
  validity(caCert, '01');
  const caName = [{ name: 'commonName', value: 'jtaak test CA' }];
  caCert.setSubject(caName);
  caCert.setIssuer(caName);
  caCert.setExtensions([
    { name: 'basicConstraints', cA: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true },
  ]);
  caCert.sign(caKeys.privateKey, forge.md.sha256.create());

  const issue = (commonName: string, serial: string, extensions: object[]) => {
    const pair = keys();
    const cert = forge.pki.createCertificate();
    cert.publicKey = pair.publicKey;
    validity(cert, serial);
    cert.setSubject([{ name: 'commonName', value: commonName }]);
    cert.setIssuer(caName);
    cert.setExtensions(extensions);
    cert.sign(caKeys.privateKey, forge.md.sha256.create());
    return { pair, cert };
  };
  const server = issue('localhost', '02', [
    { name: 'extKeyUsage', serverAuth: true },
    {
      name: 'subjectAltName',
      altNames: [
        { type: 2, value: 'localhost' },
        { type: 7, ip: '127.0.0.1' },
      ],
    },
  ]);
  const client = issue('jtaak test client', '03', [{ name: 'extKeyUsage', clientAuth: true }]);
  const passphrase = 'pfx-secret';
  const p12 = forge.pkcs12.toPkcs12Asn1(client.pair.privateKey, [client.cert], passphrase, { algorithm: '3des' });
  cachedPki = {
    ca: forge.pki.certificateToPem(caCert),
    server: { key: forge.pki.privateKeyToPem(server.pair.privateKey), cert: forge.pki.certificateToPem(server.cert) },
    client: {
      key: forge.pki.privateKeyToPem(client.pair.privateKey),
      cert: forge.pki.certificateToPem(client.cert),
      pfx: Buffer.from(forge.asn1.toDer(p12).getBytes(), 'binary'),
      passphrase,
    },
  };
  return cachedPki;
}
