# Security policy

ZapaKid is used by children. We take every report seriously.

**Please don't open a public issue for a security problem.** Report it privately through
[GitHub's private vulnerability reporting](../../security/advisories/new) on this repository.

We acknowledge reports within 3 working days and keep you updated until the issue is fixed.
We credit reporters who want to be credited.

This API must never be able to read a chat. Anything that lets the server, an operator or another user see message
content, keys other than public keys, or a kid's data they aren't allowed to see is in scope.
