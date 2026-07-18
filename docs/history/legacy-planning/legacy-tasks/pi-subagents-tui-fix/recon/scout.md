# Scout Report: pi-subagents TUI Redesign

## Files Retrieved

### Core TUI Files (src/tui/)
1. `src/tui/subagent-hub.ts` (lines 1-415) - **Primary target**: Model selection hub TUI component with agent list view and model picker
2. `src/tui/render.ts` (lines 1-1250) - **Primary target**: Async widget rendering, subagent result display, status formatting
3. `src/tui/render-helpers.ts` (lines 1-48) - **Support**: Header/footer rendering, padding, row utilities

### Extension Entry Point (src/extension/)
4. `src/extension/index.ts` (lines 1-588) - **Critical**: Tool registration, message renderers, session lifecycle, widget integration
5. `src/extension/schemas.ts` (lines 1-174) - **Reference**: TypeBox parameter schemas for subagent tool
6. `src/extension/control-notices.ts` - **Adjacent**: Subagent control notice component (not read, exists)
7. `src/extension/doctor.ts` - **Adjacent**: Diagnostics (not read, exists)

### Slash Command Bridge (src/slash/)
8. `src/slash/slash-commands.ts` (lines 1-781) - **Critical**: Slash command handlers, inline chain parsing, subagent hub invocation
9. `src/slash/slash-bridge.ts` - **Adjacent**: Event-based slash subagent communication (not read, exists)
10. `src/slash/slash-live-state.ts` - **Adjacent**: Live state management for slash results (not read, exists)
11. `src/slash/prompt-template-bridge.ts` - **Adjacent**: Prompt template delegation (not read, exists)

### Reference TUI Pattern
12. `src/runs/foreground/chain-clarify.ts` (lines 1-1334) - **Pattern reference**: Full-featured TUI with editing, model selector, thinking selector, skill selector

## Key Code

### TUI Component Pattern (from chain-clarify.ts)
```typescript
// Standard component structure
export class ChainClarifyComponent implements Component {
  readonly width = 84;
  
  constructor(
    tui: TUI,
    theme: Theme,
    // ... other params
    done: (result: ChainClarifyResult) => void,
  ) {}
  
  render(_width: number): string[] {
    // Returns array of styled lines
  }
  
  handleInput(data: string): void {
    // Keyboard handling with matchesKey()
  }
  
  invalidate(): void {}
  dispose(): void {}
}
```

### Rendering Utilities (render-helpers.ts)
```typescript
// Header with centered text and border
export function renderHeader(text: string, width: number, theme: Theme): string

// Footer with centered text and border  
export function renderFooter(text: string, width: number, theme: Theme): string

// Row with side borders
export function row(content: string, width: number, theme: Theme): string

// Padding to visible width
export function pad(s: string, len: number): string
```

### Theme Colors Used
- `border` - Box drawing characters
- `accent` - Primary highlights, selection
- `dim` - Secondary text, labels
- `toolTitle` - Tool/agent names
- `warning` - Overrides, modified state
- `success` - Current/active indicators
- `error` - Error states
- `muted` - Queued/pending states
- `toolPendingBg`, `toolSuccessBg`, `toolErrorBg` - Box backgrounds

### Key Bindings Pattern
```typescript
import { matchesKey } from "@earendil-works/pi-tui";

// Navigation
matchesKey(data, "up") / matchesKey(data, "down")
matchesKey(data, "return")  // Confirm
matchesKey(data, "escape") / matchesKey(data, "ctrl+c")  // Cancel

// Mode-specific
data === "m"  // Model selector
data === "e"  // Edit mode
data === "t"  // Thinking level
data === "s"  // Skills
```

### Subagent Hub Component (subagent-hub.ts)
- **Width**: 84 columns fixed
- **Two views**: Main agent list + Model selector overlay
- **State**: `editingAgentIndex` toggles between views
- **Model override storage**: `Map<agentName, modelFullId>`
- **Footer**: `[Enter] Confirm • [Esc] Cancel • m Model • ↑↓ Navigate`

### Render Component (render.ts)
- **Widget animation**: 80ms spinner interval for running states
- **Line truncation**: Custom `truncLine()` preserves ANSI through ellipsis
- **Result states**: running, completed, failed, detached, interrupted
- **Multi-progress label builder**: Handles parallel/chain/parallel-in-chain modes

## Architecture

### TUI Flow
```
User invokes /subagents
    ↓
slash-commands.ts:741-778 (handler)
    ↓
ctx.ui.custom<SubagentHubResult>()
    ↓
SubagentHubComponent.render()
    ↓
User confirms → saves overrides via saveBuiltinAgentOverride()
```

### Rendering Pipeline
```
extension/index.ts registers:
  - pi.registerTool() → renderCall/renderResult
  - pi.registerMessageRenderer<SlashMessageDetails>() → createSlashResultComponent
  - pi.registerMessageRenderer<SubagentNotifyDetails>() → notification display
  
Tool result rendering:
  renderSubagentResult() → Container/Box/Text/Markdown components
  syncResultAnimation() → 80ms interval for spinners
```

### Widget System
```
renderWidget(ctx, jobs) 
    ↓
buildWidgetComponent() → Component
    ↓
ctx.ui.setWidget(WIDGET_KEY, component)
    ↓
ensureWidgetAnimation() → setInterval for spinners
```

## Hidden Coupling

### 1. Width Constants
- `subagent-hub.ts:23` - `readonly width = 84`
- `chain-clarify.ts:200` - `readonly width = 84`
- **Risk**: Hardcoded width may not match Pi's TUI container expectations

### 2. Theme Color Dependencies
Both files use these theme colors without fallback:
- `th.fg("border", ...)`, `th.fg("accent", ...)`, `th.fg("dim", ...)`
- `th.fg("toolTitle", ...)`, `th.fg("warning", ...)`, `th.fg("success", ...)`
- **Risk**: If Pi's theme changes, styling breaks silently

### 3. Animation Timer Management
- `render.ts:90-96` - Global `widgetTimer`, `latestWidgetCtx`, `outputActivityCache`
- `render.ts:94` - `resultAnimationTimers` Map
- **Risk**: Global state persists across extension reloads; cleanup on `session_shutdown` (line 574-575) but not on extension unload

### 4. Slash Command ↔ Hub Coupling
- `slash-commands.ts:752-767` - Invokes hub via `ctx.ui.custom()`
- `slash-commands.ts:771-775` - Saves overrides via `saveBuiltinAgentOverride()`
- **Risk**: Hub returns model overrides; slash command persists them. If hub output format changes, persistence breaks.

### 5. Render Component ↔ Extension Lifecycle
- `extension/index.ts:513-521` - `tool_result` event triggers `renderWidget()`
- `extension/index.ts:545-586` - Session lifecycle manages widget cleanup
- **Risk**: Widget rendering depends on `state.lastUiContext`; if context is stale, `isStaleExtensionContextError()` guard catches but stops animation

### 6. ANSI Styling in truncLine()
- `render.ts:34-85` - Custom truncation preserves ANSI codes
- **Risk**: Pi's `truncateToWidth` from `pi-tui` adds `\x1b[0m` before ellipsis (line 34 comment), breaking background colors. This custom implementation is critical but fragile.

### 7. Model Resolution Chain
```
subagent-hub.ts:38-44 → resolveModelCandidate() → availableModels → agentModelOverrides
    ↓
slash-commands.ts:771-775 → saveBuiltinAgentOverride()
    ↓
agents.ts (not read) → discovers overrides on next load
```
**Risk**: Override persistence is file-based; concurrent edits could conflict.

## Test Infrastructure

**Not applicable for TUI redesign** - This is a visual/UI change. However:

- **Unit tests**: `test/unit/` - Pure unit tests with mocked Pi runtime
- **Integration tests**: `test/integration/` - Loader-based with TypeScript transform
- **Test runner**: `npm run test:unit` (uses `--experimental-strip-types`)
- **TUI testing**: No automated TUI tests exist; manual verification required

## Start Here

**First file to open**: `src/tui/subagent-hub.ts`

**Why**: This is the primary user-facing TUI component for model configuration. It's self-contained (415 lines), follows the standard Component pattern, and has clear separation between main view (`renderMainView()`) and model selector (`renderModelSelector()`). Changes here will have the most visible impact on the redesign.

**Second file**: `src/tui/render-helpers.ts` (48 lines)

**Why**: Contains the shared rendering primitives (`renderHeader`, `renderFooter`, `row`, `pad`). Any stylistic changes to match Pi's TUI should start here to ensure consistency across all components.

**Pattern reference**: `src/runs/foreground/chain-clarify.ts`

**Why**: Most feature-complete TUI in the codebase. Use as a reference for:
- Edit mode patterns (lines 319-372)
- Model selector (lines 903-975)
- Thinking selector (lines 978-1035)
- Skill selector (lines 1037-1103)
- Mode-aware rendering (single/parallel/chain)

## Open Questions for Worker

1. **What is "Pi coding agent's style"?** Need to inspect Pi's own TUI components for:
   - Color palette conventions
   - Border styles (box drawing vs simple lines)
   - Header/footer formatting patterns
   - Spacing/padding conventions

2. **Scope of redesign**: 
   - Just visual styling (colors, borders, spacing)?
   - Interaction patterns (key bindings, navigation)?
   - Component structure (width constants, viewport heights)?

3. **Backward compatibility**: Should existing key bindings be preserved? (`m` for model, `e` for edit, etc.)

4. **Testing strategy**: TUI changes require manual verification. Should worker create a test checklist?
