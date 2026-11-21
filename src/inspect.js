/**
 * nut-inspector — core logic.
 *
 * A Cashu token inspector: decode tokens offline, verify mint signatures
 * and DLEQ proofs against the mint's public keysets, ask the mint whether
 * proofs are still unspent (NUT-07 checkstate), and plan power-of-two
 * splits offline. No wallet, no keys, no spending: this tool only reads.
 */
const {
  getDecodedToken,
  getEncodedToken,
  getTokenMetadata,
  hashToCurve,
  sumProofs,
  verifyReceivedProofs,
  hasValidDleq,
  Wallet,
} = require('@cashu/cashu-ts');

const enc = new TextEncoder();

/**
 * Decode a cashu token string. Fully offline — no network — as long as the
 * token carries full (v0/v3/v4) keyset ids. Tokens with short v2 keyset ids
 * cannot be resolved offline: see decodeTokenAuto, which fetches the mint's
 * keyset list once to map them.
 */
function decodeToken(tokenString, keysetIds = []) {
  if (typeof tokenString !== 'string' || !tokenString.startsWith('cashu')) {
    throw new Error('not a Cashu token (must start with "cashu")');
  }
  const token = getDecodedToken(tokenString, keysetIds);
  const proofs = token.proofs || [];
  return {
    mint: token.mint,
    unit: token.unit || 'sat',
    memo: token.memo || null,
    total: sumProofs(proofs).toNumber(),
    proofs: proofs.map((p) => ({
      amount: Number(p.amount),
      id: p.id,
      secret: p.secret,
      C: p.C,
      dleq: p.dleq ? { e: p.dleq.e, s: p.dleq.s, r: p.dleq.r } : null,
      witness: p.witness || null,
    })),
  };
}

/** Retry a network operation a few times: some mints intermittently close
 *  cashu-ts's reused connection (UND_ERR_SOCKET), and a retry succeeds. */
async function withRetries(fn, attempts = 3) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      if (!/fetch failed|UND_ERR_SOCKET|ECONNRESET|ETIMEDOUT|socket hang up/i.test(String(err && err.message))) throw err;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw last;
}

/** Fetch a mint's keyset ids (public /v1/keysets endpoint, read-only). */
async function fetchKeysetIds(mintUrl) {
  const url = `${mintUrl.replace(/\/$/, '')}/v1/keysets`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`could not fetch keysets from ${mintUrl} (HTTP ${res.status})`);
  }
  const data = await res.json();
  return (data.keysets || []).map((k) => k.id);
}

/**
 * Decode, trying fully offline first and falling back to one keyset-list
 * fetch from the mint only when the token uses short v2 keyset ids (the
 * mint URL comes from the token itself, via getTokenMetadata).
 */
async function decodeTokenAuto(tokenString) {
  try {
    return decodeToken(tokenString);
  } catch (err) {
    if (!/short keyset ID/i.test(String(err && err.message))) throw err;
    const meta = getTokenMetadata(tokenString);
    const ids = await withRetries(() => fetchKeysetIds(meta.mint));
    return decodeToken(tokenString, ids);
  }
}

/** Fetch a mint's keysets via a Wallet (read-only; no signing). */
async function loadWallet(mintUrl, unit) {
  const wallet = new Wallet(mintUrl, { unit: unit || 'sat' });
  await wallet.loadMint();
  return wallet;
}

/**
 * Verify every proof's mint signature against the mint's public keysets,
 * and report DLEQ status. Returns per-proof results; never throws on a
 * bad proof — a bad proof is a result, not a crash.
 */
async function verifyToken(tokenString) {
  const decoded = await decodeTokenAuto(tokenString);
  const wallet = await withRetries(() => loadWallet(decoded.mint, decoded.unit));
  const getKeyset = (id) => {
    try {
      return wallet.getKeyset(id);
    } catch {
      return undefined;
    }
  };
  let verification;
  try {
    verification = await verifyReceivedProofs(decoded.proofs, getKeyset, {
      requireDleq: false,
    });
  } catch (err) {
    // verifyReceivedProofs throws on invalid options / batch cap; fall
    // back to per-proof reporting so the caller still sees which proofs failed.
    verification = {
      valid: [],
      invalid: decoded.proofs.map((p) => ({ proof: p, error: err })),
    };
  }
  // cashu-ts v4 returns { valid, invalid: [{ proof, error }] }.
  const validList = verification.valid || verification.validProofs || [];
  const invalidList = verification.invalid || verification.invalidProofs || [];
  const validSet = new Set(
    validList.map((p) => `${p.secret}:${p.amount}`),
  );
  const invalidMap = new Map(
    invalidList.map((entry) => {
      const p = entry.proof || entry;
      const err = entry.error;
      return [
        `${p.secret}:${p.amount}`,
        err ? String(err.message || err) : 'signature verification failed',
      ];
    }),
  );
  const results = decoded.proofs.map((p) => {
    const key = `${p.secret}:${p.amount}`;
    let keyset;
    let keysetKnown = true;
    try {
      keyset = wallet.getKeyset(p.id);
    } catch {
      keysetKnown = false;
    }
    // hasValidDleq needs the keyset (v4 API); without it DLEQ cannot be
    // checked, so report null rather than crash.
    let dleqValid = null;
    if (p.dleq && keyset) {
      try {
        dleqValid = hasValidDleq(p, keyset);
      } catch {
        dleqValid = false;
      }
    }
    return {
      amount: p.amount,
      id: p.id,
      secretPreview: p.secret.slice(0, 12),
      keysetKnown,
      signatureValid: validSet.has(key),
      signatureError: invalidMap.get(key) || null,
      dleqPresent: Boolean(p.dleq),
      dleqValid,
    };
  });
  return {
    mint: decoded.mint,
    unit: decoded.unit,
    total: decoded.total,
    proofCount: decoded.proofs.length,
    validCount: results.filter((r) => r.signatureValid).length,
    results,
  };
}

/**
 * Ask the mint (NUT-07 /v1/checkstate) whether each proof is unspent.
 * Y = hash_to_curve(secret), compressed hex.
 */
async function checkToken(tokenString) {
  const decoded = await decodeTokenAuto(tokenString);
  const wallet = await withRetries(() => loadWallet(decoded.mint, decoded.unit));
  const Ys = decoded.proofs.map((p) =>
    hashToCurve(enc.encode(p.secret)).toHex(),
  );
  const resp = await withRetries(() => wallet.mint.check({ Ys }));
  const states = resp.states || [];
  return {
    mint: decoded.mint,
    unit: decoded.unit,
    total: decoded.total,
    results: decoded.proofs.map((p, i) => ({
      amount: p.amount,
      id: p.id,
      secretPreview: p.secret.slice(0, 12),
      state: states[i] ? (states[i].state || 'unknown').toLowerCase() : 'unknown',
      witness: states[i] ? states[i].witness ?? null : null,
    })),
  };
}

/** Power-of-two decomposition, largest first. */
function decompose(amount) {
  const parts = [];
  let rest = amount;
  let bit = 1;
  while (bit * 2 <= rest) bit *= 2;
  while (rest > 0) {
    if (bit <= rest) {
      parts.push(bit);
      rest -= bit;
    }
    bit = Math.floor(bit / 2);
  }
  return parts;
}

/**
 * Plan a split of the token into the requested amounts, using the proofs
 * on hand. Pure offline arithmetic — no mint interaction, no spending.
 */
async function splitPlan(tokenString, amounts) {
  const decoded = await decodeTokenAuto(tokenString);
  const wanted = amounts.map((a) => {
    const n = Number(a);
    if (!Number.isInteger(n) || n <= 0) throw new Error(`bad amount: ${a}`);
    return n;
  });
  const totalWanted = wanted.reduce((a, b) => a + b, 0);
  if (totalWanted > decoded.total) {
    throw new Error(
      `requested ${totalWanted} ${decoded.unit} but token holds ${decoded.total}`,
    );
  }
  // Greedy: smallest proofs that cover each requested amount's decomposition.
  const pool = [...decoded.proofs].sort((a, b) => a.amount - b.amount);
  const used = new Set();
  const sends = [];
  for (const amount of wanted) {
    const parts = decompose(amount);
    const chosen = [];
    for (const part of parts) {
      const idx = pool.findIndex((p, i) => !used.has(i) && p.amount === part);
      if (idx === -1) {
        // No exact proof: take the smallest unused proof above the part and
        // note the overpay (a real swap would return change; this is a plan).
        const over = pool.findIndex(
          (p, i) => !used.has(i) && p.amount > part,
        );
        if (over === -1) {
          throw new Error(
            `cannot cover ${part} ${decoded.unit}: no proof of that size or larger left`,
          );
        }
        used.add(over);
        chosen.push({ ...pool[over], planned: part, overpay: pool[over].amount - part });
      } else {
        used.add(idx);
        chosen.push({ ...pool[idx], planned: part, overpay: 0 });
      }
    }
    sends.push({ amount, proofs: chosen });
  }
  const keep = pool.filter((_, i) => !used.has(i));
  return {
    mint: decoded.mint,
    unit: decoded.unit,
    tokenTotal: decoded.total,
    requestedTotal: totalWanted,
    sends,
    keep: keep.map((p) => ({ amount: p.amount, id: p.id })),
    keepTotal: keep.reduce((a, p) => a + p.amount, 0),
  };
}

module.exports = {
  decodeToken,
  decodeTokenAuto,
  verifyToken,
  checkToken,
  splitPlan,
  decompose,
  getEncodedToken,
  getTokenMetadata,
};
