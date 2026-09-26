# Security policy

## Reporting a vulnerability

Please don't report security problems in public issues. Report them privately
through GitHub: on the repository's **Security** tab, choose **Report a
vulnerability**. Include the affected package and version, what an attacker can
do, and how to reproduce it.

You'll get a reply within a week. Once a fix is released, the advisory is
published with credit to you, unless you'd rather stay anonymous.

## Supported versions

Fixes go into the latest release. jtaak is at 0.x, so there are no long-term
support branches yet.

## What's in scope

Of particular interest:

- **The script sandbox.** Pre-request and test scripts run in QuickJS with a
  deadline and a memory cap, and must not be able to reach Node.js, the host
  process, the file system or the network.
- **Importing untrusted files.** Native exports, Postman collections and
  OpenAPI documents may come from someone else, and are validated before
  anything is stored.
- **Credentials in exports.** Exports blank credentials unless the user asks to
  include them.
