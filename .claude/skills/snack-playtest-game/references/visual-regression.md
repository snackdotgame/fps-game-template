# Visual Regression Testing

## Contents

- Add or skip decision
- State selection
- Determinism and hooks
- Snack host-shell requirements
- Screenshot comparison
- Multiplayer and mobile cases
- Reporting

## Add Or Skip Decision

Add or extend screenshot baselines when:

- HUD, menus, responsive layout, or text fit could regress
- an important arena, board, level, or active-play composition is stable
- imported assets must remain visible at real gameplay scale
- rendering, lighting, materials, or post-processing changed substantially
- the project is preparing for a release-quality claim

Skip or defer when the project is still exploratory, the state is not valuable enough to protect,
or uncontrolled randomness makes a baseline misleading. Record the reason. Use a nonblank canvas
check for basic rendering smoke, but do not treat it as proof of correct composition.

## State Selection

Prefer two to five decision-rich states:

- active gameplay desktop
- active gameplay on a declared phone/tablet orientation
- lobby/loading/disconnected/relaunching for networked games
- pause/settings or another changed overlay
- fail/retry, eliminated/spectating, round end, or win
- high-load or crowded player state
- imported hero asset under actual gameplay camera and lighting

Avoid title-only screenshots unless the title/menu is the changed feature.

## Determinism And Hooks

Use project-owned hooks only when they improve repeatability without bypassing authority:

```ts
export interface SnackVisualTestHooks {
  seedPresentation(value: number): void;
  setReducedMotion(enabled: boolean): void;
  setPresentationPaused(paused: boolean): void;
  hideDebugUi(hidden: boolean): void;
}

declare global {
  interface Window {
    __SNACK_VISUAL_TEST_HOOKS__?: SnackVisualTestHooks;
  }
}
```

Gate hooks to development/test builds. Limit them to client presentation. Reach authoritative match
states through normal inputs, controlled local profiles, or an explicit test fixture owned by the
project—never by mutating server state from a browser global.

Before capture:

- seed cosmetic randomness
- reduce or pause camera shake, particles, animated noise, and timers that are irrelevant to the
  assertion
- hide debug overlays unless the test covers them
- wait for fonts, assets, bootstrap, and several rendered frames
- fix viewport, device scale, profile count, and game state
- retain UI/state that is part of acceptance criteria rather than masking it

## Snack Host-Shell Requirements

Open `http://127.0.0.1:3030/`, or the configured shell port. Do not capture the Vite-only client at
`3031` for networked gameplay; it lacks the Snack launch envelope.

Keep the host shell and iframe composition stable. If screenshot scope intentionally crops to the
game iframe, still launch through the shell and document the crop. Do not depend on private shell
messages or undocumented selectors as a public game API.

## Screenshot Comparison

Use the project's existing browser test runner. For Playwright, prefer named projects or fixtures
for desktop/mobile and deliberate `toHaveScreenshot` thresholds.

- keep thresholds low for stable menus and HUD
- allow only measured tolerance for antialiasing or GPU variance
- avoid broad masks that hide the changed area
- store baselines beside the test or according to project convention
- review baseline updates as authored changes, not automatic approvals
- keep functional interaction assertions alongside screenshots

Run comparison from a consistent environment. Different GPUs, fonts, color profiles, and browser
versions can create noise; document environment and use CI baselines intentionally.

## Multiplayer And Mobile Cases

For multiplayer visuals:

- use at least two distinct local profiles
- capture state that proves player distinction and shared authoritative agreement
- include disconnected/relaunching, eliminated, waiting, or teammate/opponent state when changed
- verify hidden/private information remains hidden

For mobile:

- capture every declared orientation relevant to the change
- include safe areas and touch controls
- use longest values and crowded HUD states
- verify interaction, not just layout

## Reporting

Report:

```text
Visual harness: added / extended / skipped
States:
Profiles and seed:
Viewports/DPR:
Host-shell URL:
Update command:
Compare command:
Baseline paths:
Thresholds and masks:
Functional assertions:
Known flake risks:
```
