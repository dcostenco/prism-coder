# Engineering Standards

1. **Vercel Build Sync:** Always run a local production build (`cd portal && npm run build`) before pushing major UI changes. This is the only way to catch hydration mismatches (Error #310) and Hook violations before they hit production.
2. **Middleware Governance:** When adding new public API routes (like dashboard-config), they MUST be added to the `PUBLIC_PREFIXES` array in `middleware.ts`. Failure to do so causes guest-access redirects to /auth, resulting in a 'black screen' on landing pages.
3. **Hydration Stability:** Never use conditional returns like `if (!mounted) return null` in a way that changes the component tree size between server and client. Prefer CSS-based visibility (e.g., `opacity: mounted ? 1 : 0`) to maintain hook count integrity.
4. **Emergency UI Fallbacks:** Always implement a hardcoded 'Emergency Fallback' template in the frontend. If the API or Database fails, the UI should detect the error and force-render stable clinical cards from local constants instead of showing an empty state.
5. **Hook Order:** All React hooks (useEffect, useCallback, useRef) must be declared at the absolute top of the component, before any conditional logic or early returns.
