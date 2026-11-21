/**
 * Self-test for nut-inspector. Run: npm test
 *
 * Builds fixture tokens with the same library the CLI uses, exercises
 * every command, and asserts on real behaviour. The live-mint section
 * only reads public endpoints (keysets, checkstate) — no wallet, no spend.
 */
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { getEncodedToken } from '@cashu/cashu-ts';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));

function run(args) {
  // stdout only: library deprecation warnings go to stderr and must not
  // pollute --json output.
  const r = spawnSync('node', [CLI, ...args], { encoding: 'utf8' });
  return { code: r.status, out: r.stdout };
}

// Fixture: a structurally valid token. The C values are NOT real mint
// signatures — decode/split must still work; verify must report INVALID.
function fixtureToken() {
  const proofs = [
    { amount: 1, id: '009a1f293253e41e', secret: 'fixture-secret-1', C: '02' + '11'.repeat(32) },
    { amount: 2, id: '009a1f293253e41e', secret: 'fixture-secret-2', C: '03' + '22'.repeat(32) },
    { amount: 4, id: '009a1f293253e41e', secret: 'fixture-secret-4', C: '02' + '33'.repeat(32) },
    { amount: 8, id: '009a1f293253e41e', secret: 'fixture-secret-8', C: '03' + '44'.repeat(32) },
  ];
  return getEncodedToken({
    mint: 'https://testnut.cashu.space',
    proofs,
    unit: 'sat',
    memo: 'nut-inspector self-test',
  });
}

const token = fixtureToken();
console.log('fixture token:', token.slice(0, 60) + '...');

// 1. decode (offline)
{
  const { code, out } = run(['decode', token, '--json']);
  assert.strictEqual(code, 0, out);
  const d = JSON.parse(out);
  assert.strictEqual(d.mint, 'https://testnut.cashu.space');
  assert.strictEqual(d.unit, 'sat');
  assert.strictEqual(d.memo, 'nut-inspector self-test');
  assert.strictEqual(d.total, 15);
  assert.strictEqual(d.proofs.length, 4);
  assert.deepStrictEqual(d.proofs.map((p) => p.amount), [1, 2, 4, 8]);
  console.log('ok: decode');
}

// 2. decode rejects garbage
{
  const { code } = run(['decode', 'not-a-token']);
  assert.notStrictEqual(code, 0);
  console.log('ok: decode rejects non-token');
}

// 3. split plan (offline): 5 = 4+1, 2 exact, keep 8
{
  const { code, out } = run(['split', token, '5', '2', '--json']);
  assert.strictEqual(code, 0, out);
  const s = JSON.parse(out);
  assert.strictEqual(s.tokenTotal, 15);
  assert.strictEqual(s.requestedTotal, 7);
  assert.strictEqual(s.keepTotal, 8);
  assert.deepStrictEqual(s.sends[0].proofs.map((p) => p.amount).sort(), [1, 4]);
  assert.deepStrictEqual(s.sends[1].proofs.map((p) => p.amount), [2]);
  console.log('ok: split 5+2, keep 8');
}

// 4. split rejects over-request
{
  const { code } = run(['split', token, '16']);
  assert.notStrictEqual(code, 0);
  console.log('ok: split rejects amount > total');
}

// 5. verify against the live test mint: dummy signatures must be INVALID
//    (and the run must not crash on the unknown keyset id).
{
  const { code, out } = run(['verify', token, '--json']);
  const v = JSON.parse(out);
  assert.strictEqual(v.proofCount, 4);
  assert.strictEqual(v.validCount, 0, out);
  assert.ok(v.results.every((r) => r.signatureValid === false));
  assert.strictEqual(code, 2, 'verify exits 2 when any signature is invalid');
  console.log('ok: verify reports 0/4 valid for dummy signatures (exit 2)');
}

// 6. check against the live test mint: record what the mint says about
//    proofs it never issued. (Behaviour is asserted loosely — the point
//    is a real mint round-trip, not a guessed state.)
{
  const { code, out } = run(['check', token, '--json']);
  const c = JSON.parse(out);
  assert.strictEqual(c.results.length, 4);
  const states = [...new Set(c.results.map((r) => r.state))];
  console.log('ok: check round-trip, mint states for unknown proofs:', states.join(', '), `(exit ${code})`);
}

console.log('\nAll self-tests passed.');

// 7. Real token: mint 1 sat from the public test mint (FakeWallet — the
//    Lightning invoice is simulated as paid, no real funds move), then
//    decode/verify/check it for real. A genuinely minted proof must
//    verify VALID with DLEQ and report unspent.
{
  let realToken = null;
  for (let attempt = 1; attempt <= 3 && !realToken; attempt++) {
    try {
      const { Wallet } = await import('@cashu/cashu-ts');
      const wallet = new Wallet('https://testnut.cashu.space', { unit: 'sat' });
      await wallet.loadMint();
      const quote = await wallet.createMintQuoteBolt11(1);
      // The test mint intermittently closes cashu-ts's reused connection
      // (UND_ERR_SOCKET, ~50% of quote-check calls); retry the check, and
      // poll until the FakeWallet marks the quote PAID.
      let paid;
      for (let i = 0; i < 8; i++) {
        try {
          paid = await wallet.checkMintQuoteBolt11(quote.quote);
          if (paid.state === 'PAID') break;
        } catch (err) {
          paid = undefined;
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
      if (!paid || paid.state !== 'PAID') throw new Error('quote never reached PAID');
      let proofs;
      for (let i = 0; i < 5; i++) {
        try {
          proofs = await wallet.mintProofsBolt11(1, quote.quote);
          break;
        } catch (err) {
          await new Promise((r) => setTimeout(r, 1000));
        }
      }
      if (!proofs) throw new Error('mintProofs kept failing');
      assert.strictEqual(proofs.length, 1);
      realToken = getEncodedToken({
        mint: 'https://testnut.cashu.space',
        proofs,
        unit: 'sat',
      });
    } catch (err) {
      console.log(`  (real-mint attempt ${attempt} failed: ${err.message})`);
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  if (!realToken) {
    console.log('SKIP: real-token step — test mint unreachable after 3 attempts');
  } else {
    {
      const { code, out } = run(['decode', realToken, '--json']);
      assert.strictEqual(code, 0, out);
      const d = JSON.parse(out);
      assert.strictEqual(d.mint, 'https://testnut.cashu.space');
      assert.strictEqual(d.total, 1);
      assert.strictEqual(d.proofs.length, 1);
      assert.ok(d.proofs[0].dleq, 'real minted proof carries DLEQ');
      console.log('ok: decode real 1-sat token (v2 short keyset id resolved)');
    }
    {
      const { code, out } = run(['verify', realToken, '--json']);
      assert.strictEqual(code, 0, out);
      const v = JSON.parse(out);
      assert.strictEqual(v.validCount, 1);
      assert.strictEqual(v.results[0].dleqValid, true);
      console.log('ok: verify real token 1/1 VALID, DLEQ valid (exit 0)');
    }
    {
      const { code, out } = run(['check', realToken, '--json']);
      assert.strictEqual(code, 0, out);
      const c = JSON.parse(out);
      assert.strictEqual(c.results[0].state, 'unspent');
      console.log('ok: check real token unspent (exit 0)');
    }
    console.log('\nAll self-tests passed (incl. real-token step).');
  }
}
