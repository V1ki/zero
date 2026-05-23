# x_search Usage Probe

This is a manual quota probe for `grok-4.3` plus xAI's hosted `x_search` Responses tool.
It uses the local Zero vault credential (`x_premium_oauth_session`, or `xai_api_key` as a
fallback), sends repeated requests, and writes request-level usage plus limit/reset hints.

The probe is intentionally bounded. It stops on the first likely quota/rate-limit response
unless `--no-stop-on-limit` is provided.

```bash
bun run x-search:probe -- --max-requests 50 --delay-ms 30000
```

Useful faster smoke test:

```bash
bun run x-search:probe -- --max-requests 1 --delay-ms 0
```

Outputs are written under:

```text
.zero/benchmarks/x-search-usage-probe/<run-id>/
```

Files:

- `config.json`: probe parameters.
- `requests.jsonl`: one JSON object per request, including status, observed headers, usage,
  x_search call count, rate-limit header observations, and limit/reset signals.
- `summary.json`: aggregate usage, request counts with/without x_search, rate-limit header
  observations, and the first inferred limit/reset time, if observed.

Common options:

- `--model grok-4.3`
- `--query "X Premium Grok usage limits x_search"`
- `--max-requests 100`
- `--delay-ms 60000`
- `--max-output-tokens 120`
- `--image-understanding`
- `--video-understanding`
- `--no-stop-on-limit`

The xAI Responses API reports request usage, but it does not currently expose a separate
remaining X Premium subscription counter. Reset time is inferred only from response headers
such as `retry-after` / `x-ratelimit-reset` or from provider error text.

Grok Web's settings usage panel appears to use a separate billing credits API
(`/rest/grok/credits`, `GetGrokCreditsConfig`) with fields like `credit_usage_percent` and
`billing_period_end`. This probe does not read browser cookies or call that private web
session endpoint; use it as an out-of-band manual cross-check for subscription-period usage.
