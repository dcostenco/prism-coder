# Verification Planner Examples

## JSON Schema Example
```json
{
  "tests": [
    {
      "id": "db-schema-exists",
      "layer": "data",
      "description": "Ensure the users table exists",
      "severity": "abort",
      "assertion": {
        "type": "sqlite_query",
        "target": "SELECT name FROM sqlite_master WHERE type='table' AND name='users'",
        "expected": [{ "name": "users" }]
      }
    },
    {
      "id": "api-health",
      "layer": "pipeline",
      "description": "API health endpoint returns 200",
      "severity": "gate",
      "timeout_ms": 5000,
      "retry_count": 2,
      "assertion": {
        "type": "http_status",
        "target": "http://localhost:3000/health",
        "expected": 200
      }
    }
  ]
}
```
