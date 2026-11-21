# nut-inspector

Inspect Cashu ecash tokens from the command line: decode them, verify the
mint's signatures and DLEQ proofs, ask the mint whether the proofs are
still unspent, and plan power-of-two splits. Read-only — it never signs,
never spends, and never holds keys.

Built with [`@cashu/cashu-ts`](https://github.com/cashubtc/cashu-ts) for
[Nut November 2026](https://nutnovember.org/), a Cashu builders hackathon.

## Install

Requires Node.js 18+.

```sh
npm install
```

## Usage

```sh
node src/cli.js decode <token> [--json]   # parse the token
node src/cli.js verify <token> [--json]   # check mint signatures + DLEQ
node src/cli.js check  <token> [--json]   # ask the mint if proofs are unspent
node src/cli.js split  <token> <amt...> [--json]  # plan a split, offline
```

Or, after `npm link`: `nut-inspector decode <token>`.

- `decode` prints the mint, unit, memo, total, and every proof (amount,
  keyset id, secret prefix, blinded signature prefix, DLEQ presence).
  It is fully offline for tokens with full keyset ids; tokens with short
  v2 keyset ids need one fetch of the mint's public keyset list to resolve
  the ids (the mint URL comes from the token itself).
- `verify` fetches the mint's public keysets and reports, per proof,
  whether the keyset is known, whether the mint signature is valid, and
  whether the DLEQ proof is present and valid. Exits 2 when any signature
  is invalid.
- `check` asks the mint (NUT-07 `/v1/checkstate`) whether each proof is
  `unspent`, `spent`, or `pending`. Exits 2 when any proof is not unspent.
- `split` plans splitting the token into the requested amounts using the
  proofs on hand (power-of-two decomposition, smallest proofs first) and
  shows what stays behind. It is a plan only — it never swaps or spends.

`--json` prints machine-readable JSON on stdout. Warnings from the
underlying library go to stderr and never pollute `--json` output.

## Example

```sh
$ node src/cli.js decode 'cashuB...' --json
{
  "mint": "https://testnut.cashu.space",
  "unit": "sat",
  "memo": null,
  "total": 1,
  "proofs": [ { "amount": 1, "id": "017bc6…", "secret": "…", "C": "03…", "dleq": { … } } ]
}
```

## Tests

```sh
npm test
```

The self-test (`test/selftest.mjs`) builds fixture tokens with the same
library the CLI uses, exercises every command, and asserts on real
behaviour. It also mints a real 1-sat token from the public test mint
[testnut.cashu.space](https://testnut.cashu.space) (FakeWallet — its
Lightning invoices are simulated as paid, no real funds move) and checks
that the CLI decodes it, verifies its signature 1/1 VALID with a valid
DLEQ proof, and reports it unspent. The live-mint steps need network; if
the test mint is unreachable after retries, the real-token step is skipped
with a printed note instead of failing the run.

Note: the test mint intermittently closes reused connections
(`UND_ERR_SOCKET`); the CLI retries transient network failures up to
3 times.

## Licence

MIT — see [LICENSE](LICENSE).
