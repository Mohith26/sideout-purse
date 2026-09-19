# Webhook destination validation

A webhook endpoint is a URL a tenant chooses and Purse then fetches. Without a check on
where it points, any tenant key turns the platform into a request forwarder: `http://localhost`,
`http://10.0.0.1`, `http://169.254.169.254/latest/meta-data/` and every other address the
deployment happens to reach. This document is the contract for the check that closes that.

The code is `apps/purse/src/webhooks/destination.ts` (what may be delivered to),
`apps/purse/src/webhooks/transport.ts` (how the attempt leaves the process) and the
`post` step of `apps/purse/src/webhooks/dispatcher.ts` (where the two meet). The table is
driven by `apps/purse/test/webhooks/destination.test.ts` and
`apps/purse/test/webhooks/transport.test.ts`.

## The rule

A destination is accepted only when **all** of the following hold.

| | Rule | Refusal reason |
|---|---|---|
| Form | An absolute URL, no whitespace, at most 2000 characters | `not_absolute`, `too_long` |
| Scheme | `https`, or `http` when the app is in development (`NODE_ENV` is not `production`) | `scheme_not_allowed`, `insecure_scheme` |
| Credentials | No username and no password in the URL | `credentials_present` |
| Fragment | No `#fragment` (it is never sent, so it can only mislead) | `fragment_present` |
| Host | Present | `host_missing` |
| Port | Any port, unless the deployment set `WEBHOOK_ALLOWED_PORTS` | `port_not_allowed` |
| Address | Public unicast, in both families | the class, below |

The address rules refuse, in IPv4: `0.0.0.0/8`, `10/8`, `100.64/10` (carrier NAT),
`127/8`, `169.254/16`, `172.16/12`, `192.0.0/24`, `192.0.2/24`, `192.88.99/24`,
`192.168/16`, `198.18/15`, `198.51.100/24`, `203.0.113/24`, `224/4` and `240/4`
(including the broadcast address); and in IPv6: `::`, `::1`, `::/96`, `::ffff:0:0/96`
(IPv4-mapped), `64:ff9b::/96`, `100::/64`, `2001::/32`, `2001:db8::/32`, `2002::/16`,
`fc00::/7`, `fe80::/10`, `fec0::/10` and `ff00::/8`. Anything the runtime returns that is
not a recognised public unicast address is refused as `unsupported_address_family`.

The reasons are the `detail.reason` of the API error, one of `loopback_address`,
`private_address`, `link_local_address`, `unique_local_address`, `multicast_address`,
`reserved_address`, `unspecified_address`, `ipv4_mapped_address`,
`unsupported_address_family` or `unresolvable`.

**Spellings.** `https://2130706433/`, `https://0177.0.0.1/`, `https://0x7f000001/`,
`https://127.1/` and `https://[::ffff:127.0.0.1]/` are all `127.0.0.1`. The WHATWG URL
parser normalises the first four; `parseIpv4Loose` parses them again anyway, so no
difference between two parsers can let one through. An IPv4-mapped IPv6 **literal** is
always refused, even when the address it carries is public: write the IPv4 plainly. A
*resolver* that answers in that form is judged on the IPv4 it carries, because some
platforms answer that way for an ordinary A record.

**Every answer must pass.** A hostname that resolves to a set is refused when any member
of the set is non-public, so a round-robin of one public and one private address is not a
way in.

## Checked twice, and pinned

A hostname that answers publicly when the endpoint is registered can answer privately an
hour later — DNS rebinding. So:

- **At registration** (`POST`/`PATCH` on `/v1/webhooks/endpoints` and the console's
  `/console/tenants/:id/webhooks/endpoints`), every rule above is applied. A host that does
  **not resolve at all** is accepted: an integration may register before its DNS is live,
  and nothing can be delivered to a name that does not resolve anyway.
- **At every dispatch attempt**, the whole check runs again before anything is signed. A
  destination that now fails is not fetched; the attempt is recorded in
  `webhook_delivery_attempts` with `response_status` null and an `error` of
  `destination_refused: <reason>: <message>`, and the ordinary retry schedule applies. An
  operator sees that string in the console's delivery log (`DeliveryTable`, the Error
  column of the attempts panel) and fixes the endpoint or disables it. At dispatch an
  unresolvable host is a failure, not a pass.
- **The connection is pinned.** The transport hands the socket the exact address the check
  approved through a custom `lookup`, so the address that was classified is the address
  that is dialled; a second DNS answer in between changes nothing. TLS still uses the
  hostname, so the certificate is validated against the name the tenant registered, and
  the `Host` header still names it so a virtual host routes it as the tenant meant.

## Bounds on one attempt

`node:http`/`node:https`, not `fetch`, because the transport needs the pinned `lookup`
and the bounds:

- **No redirects, ever.** `node:http` does not follow one. A 3xx is reported as the
  non-2xx it is and the retry schedule handles it; Purse never dials a second, unchecked
  destination.
- **Connect timeout** 5 s, **total timeout** `WEBHOOK_DELIVERY_TIMEOUT_MS` (10 s by
  default, and the lease outlives it). Both are clamped so the connect bound never exceeds
  the total.
- **Response cap** 64 KiB. The body is never stored; it is read only far enough to free
  the socket, and a receiver that answers with more has its attempt abandoned
  (`response_too_large`).
- **A fresh connection per attempt** (`agent: false`), so no pooled socket outlives the
  address that was checked.

## The escape hatch

`WEBHOOK_ALLOWED_HOSTS` is a comma-separated list of hosts exempt from the address rules,
matched against the host as written (lowercased, IPv6 brackets stripped). It is **empty by
default in every environment**, so a deployment that never sets it refuses every private
destination. It exists because the tests, the sample receiver and a developer running
`pnpm dev` all post to loopback:

```
WEBHOOK_ALLOWED_HOSTS=localhost,127.0.0.1,::1
```

It never buys plain `http` in production — the scheme rule is judged before the allowlist —
and a production process that has a non-empty list says so in its boot log at `warn`, since
it is the one way in to a private network. The deployed Purse service leaves it unset.

`WEBHOOK_ALLOWED_PORTS` is the deployment's port policy, also a comma-separated list and
also empty by default. **Empty means every port is allowed**, which is the deliberate
default: receivers behind a proxy on `:8443` are ordinary. Set it only where a deployment
wants to pin the ports it will dial.

Both are read in `apps/purse/src/env.ts` and become a `DestinationPolicy`
(`destinationPolicy()`), which `createApp` hands to the v1 and console routes and
`index.ts` hands to the dispatcher. Tests get `TEST_WEBHOOK_POLICY` from
`apps/purse/test/helpers.ts`, which is the same hatch with the loopback hosts named.

## Self-serve sandboxes

Self-serve sandbox tenants still cannot register or mutate webhook endpoints at all; they
receive `403 permission_error / sandbox_webhooks_unavailable` (`docs/sandbox.md`). With
destination validation in place that refusal is no longer load-bearing for the SSRF risk —
it is now a deliberate abuse-surface choice, recorded in `docs/decisions.md`. Reads remain
available.

## Changing the rule

A new refusal reason is a new member of `DestinationRefusal` with its message and, if it
is an address class, its entry in `REFUSAL_OF_CLASS` — plus a row in the unit table. A
change to what the API returns is a contract change: rerun
`UPDATE_CONTRACT_FIXTURES=1 pnpm --filter @purse/api test test/contract` and commit the
fixture.
