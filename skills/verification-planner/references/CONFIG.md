# Verification Planner Configuration

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PRISM_VERIFICATION_HARNESS_ENABLED` | `false` | Master switch for v7.2.0 enhanced verification |
| `PRISM_VERIFICATION_LAYERS` | `data,agent,pipeline` | Comma-separated list of active layers |
| `PRISM_VERIFICATION_DEFAULT_SEVERITY` | `warn` | Global severity floor override |

## Severity Guidelines

- **warn**: For non-critical assertions during exploration.
- **gate**: Guards feature correctness (schema migrations, API contracts).
- **abort**: Safety-critical or data-destructive scenarios.
