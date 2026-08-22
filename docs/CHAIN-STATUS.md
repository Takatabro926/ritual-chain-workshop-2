# Is the chain up?

This repository says throughout that Ritual Chain was unreachable, and that nothing
here was deployed. That is a claim about the world, so it comes with a check anyone
can re-run:

```bash
cd hardhat && node scripts/probe-chain.ts
```

It resolves four hosts, contacts each one, prints what came back, and exits non-zero
when the RPC does not answer `eth_chainId`.

## Last run

```
probed 2026-08-22T21:34:02.759Z

rpc       162.255.119.231   fetch failed (UND_ERR_CONNECT_TIMEOUT)
explorer  162.255.119.231   fetch failed (UND_ERR_CONNECT_TIMEOUT)
faucet    162.255.119.231   fetch failed (UND_ERR_CONNECT_TIMEOUT)
docs      35.186.235.8      HTTP 200 in 223ms

The chain is not reachable.
```

## What that actually says

- **It is not DNS, and it is not a dead project.** All four names resolve, and the
  documentation host answers in a fifth of a second.
- **The three chain services share one address.** `rpc`, `explorer` and `faucet` all
  point at `162.255.119.231`, and none of them completes a TCP connection —
  `UND_ERR_CONNECT_TIMEOUT`, matching `curl`'s exit 28. Requests are not refused and
  not answered; they hang until they are given up on.
- So the outage is one unreachable host carrying all three services, not four separate
  failures and not something at this end.

## What it means for this repository

Three things could not be done, and are not claimed:

1. **No deployment.** No contract address and no transaction hash exist, because
   nothing could be sent.
2. **No funding.** The faucet is on the same unreachable host, so even a working RPC
   would have left the deployer with no balance.
3. **No real oracle read.** No observed value in this repository came back from a TEE
   executor. Every reading was recorded from a live endpoint over ordinary HTTPS and
   replayed locally — real numbers, but they never travelled through the precompile.

Everything else was done, and can be checked: 85 tests at full coverage, a market
driven from creation to payout against a real node on every CI run, and a frontend
photographed doing the same. See [`../README.md`](../README.md).
