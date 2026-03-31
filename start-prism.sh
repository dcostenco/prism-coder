#!/bin/bash

# Start the actual server — exec keeps stdio pipes attached for MCP
exec /usr/bin/env node /Users/admin/prism/dist/server.js "$@"
