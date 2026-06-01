# PMTI Watch List

## Active risks

- **Schema/runtime split:** Adding `thinking` only to TypeBox schemas without carrying it through execution would create a UI/API no-op.
- **Precedence ambiguity:** Inline thinking must override agent overrides and frontmatter, but `off` must be treated intentionally rather than as missing.
- **TUI model suffix coupling:** Existing model selectors preserve known `:thinking` suffixes; `/subagents` thinking UI should not duplicate or corrupt suffix state.
- **Foreground/background parity:** Single, parallel, chain, async, and forked contexts may each build child sessions through different paths.
- **Test runner conventions:** Tests must use Node's built-in runner and existing support shims.

## Open questions

- Whether `thinking` should be represented internally as a separate field throughout dispatch or normalized into a model suffix at a specific boundary.
- Whether `/subagents` should show unsupported levels as disabled choices or filter them entirely based on `thinkingLevelMap`.
