#!/usr/bin/env node
/**
 * nut-inspector — Cashu token inspector CLI.
 *
 *   nut-inspector decode <token>            parse a token (see below)
 *   nut-inspector verify <token>            check mint signatures + DLEQ
 *   nut-inspector check <token>             ask the mint if proofs are unspent
 *   nut-inspector split <token> <amt...>    plan a power-of-two split
 *
 * decode/split are offline for tokens with full keyset ids; tokens with
 * short v2 keyset ids need one keyset-list fetch from the mint named in
 * the token. This tool only reads: it never signs, never spends, and
 * never holds keys.
 */
const { decodeTokenAuto, verifyToken, checkToken, splitPlan } = require('./inspect');

function usage() {
  console.log(`nut-inspector — inspect Cashu ecash tokens

Usage:
  nut-inspector decode <token> [--json]
  nut-inspector verify <token> [--json]
  nut-inspector check <token> [--json]
  nut-inspector split <token> <amount...> [--json]

decode  Parse the token (mint, unit, memo, proofs). Offline for tokens
        with full keyset ids; v2 short keyset ids need one keyset-list
        fetch from the mint named in the token.
verify  Verify each proof's mint signature against the mint's public
        keysets and report DLEQ status. Needs network (keyset fetch only).
check   Ask the mint (NUT-07 checkstate) whether each proof is unspent.
split   Plan splitting the token into the given amounts.
        Shows which proofs cover each amount and what stays behind
        (keyset fetch only for v2 short-id tokens, as with decode).`);
}

function printTable(rows) {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => String(r[i]).length)));
  for (const row of rows) {
    console.log(row.map((c, i) => String(c).padEnd(widths[i])).join('  '));
  }
}

async function main() {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const rest = args.filter((a) => a !== '--json');
  const [cmd, token, ...extra] = rest;
  if (!cmd || cmd === '--help' || cmd === '-h') {
    usage();
    process.exit(cmd ? 0 : 1);
  }
  try {
    if (cmd === 'decode') {
      const d = await decodeTokenAuto(token);
      if (json) return console.log(JSON.stringify(d, null, 2));
      console.log(`mint:  ${d.mint}`);
      console.log(`unit:  ${d.unit}`);
      console.log(`memo:  ${d.memo || '(none)'}`);
      console.log(`total: ${d.total} ${d.unit} (${d.proofs.length} proofs)`);
      console.log('');
      printTable([
        ['amount', 'keyset id', 'secret…', 'C…', 'dleq'],
        ...d.proofs.map((p) => [
          p.amount,
          p.id,
          p.secret.slice(0, 12),
          p.C.slice(0, 10),
          p.dleq ? 'yes' : 'no',
        ]),
      ]);
    } else if (cmd === 'verify') {
      const v = await verifyToken(token);
      if (v.validCount !== v.proofCount) process.exitCode = 2;
      if (json) return console.log(JSON.stringify(v, null, 2));
      console.log(`mint:  ${v.mint}`);
      console.log(`total: ${v.total} ${v.unit} — ${v.validCount}/${v.proofCount} signatures valid`);
      console.log('');
      printTable([
        ['amount', 'keyset', 'known', 'signature', 'dleq'],
        ...v.results.map((r) => [
          r.amount,
          r.id.slice(0, 16),
          r.keysetKnown ? 'yes' : 'NO',
          r.signatureValid ? 'VALID' : `INVALID${r.signatureError ? ` (${r.signatureError})` : ''}`,
          r.dleqPresent ? (r.dleqValid ? 'valid' : 'INVALID') : 'absent',
        ]),
      ]);
    } else if (cmd === 'check') {
      const c = await checkToken(token);
      if (c.results.some((r) => r.state !== 'unspent')) process.exitCode = 2;
      if (json) return console.log(JSON.stringify(c, null, 2));
      console.log(`mint:  ${c.mint}`);
      console.log(`total: ${c.total} ${c.unit}`);
      console.log('');
      printTable([
        ['amount', 'keyset', 'secret…', 'state'],
        ...c.results.map((r) => [r.amount, r.id.slice(0, 16), r.secretPreview, r.state]),
      ]);
    } else if (cmd === 'split') {
      if (extra.length === 0) throw new Error('split needs at least one amount');
      const s = await splitPlan(token, extra);
      if (json) return console.log(JSON.stringify(s, null, 2));
      console.log(`mint:  ${s.mint}`);
      console.log(`token: ${s.tokenTotal} ${s.unit} — splitting off ${s.requestedTotal}, keeping ${s.keepTotal}`);
      console.log('');
      for (const send of s.sends) {
        console.log(`send ${send.amount} ${s.unit}:`);
        for (const p of send.proofs) {
          console.log(
            `  proof ${p.amount} ${s.unit} (keyset ${p.id.slice(0, 16)})` +
              (p.overpay ? ` — covers ${p.planned}, overpay ${p.overpay} (change on swap)` : ` — exact`),
          );
        }
      }
      console.log(`keep: ${s.keepTotal} ${s.unit} (${s.keep.length} proofs)`);
    } else {
      console.error(`unknown command: ${cmd}`);
      usage();
      process.exit(1);
    }
  } catch (err) {
    console.error(`error: ${err.message || err}`);
    process.exit(1);
  }
}

main();
