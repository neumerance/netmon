# NetMon — UI/UX Design Spec

Status: authoritative design spec for `web/` (Vue 3 `<script setup>`, plain JS, Vite, Tailwind CSS v4 via `@tailwindcss/vite`).
Audience: the frontend agent and the e2e agent. Where this doc and `PLAN.md` disagree on **API/data shape**, `PLAN.md` wins. Where they disagree on **look, layout, copy or interaction**, this doc wins.

Design intent: a calm, dense network-operations console (Linear / Vercel / UniFi / Grafana polish). Dark by default. Color carries meaning: neutrals for chrome, a single accent for interaction, semantic colors only for state, and category tints only inside device-type icon tiles. Nothing blinks unless something is actually wrong.

---

## 0. File and component map

```
web/
  index.html                  Inter from Google Fonts (preconnect + css2?family=Inter:wght@400;500;600;700&display=swap),
                              inline pre-paint theme script (see §1.7), <title>NetMon</title>, favicon.svg + favicon-alert.svg
  src/style.css               @import "tailwindcss"; @custom-variant; @theme tokens; light overrides; base layer; keyframes
  src/main.js
  src/App.vue                 page shell + grid; owns modals/drawer open state
  src/lib/
    api.js                    fetch wrappers (/api/...)
    format.js                 formatMbps, formatMs, formatPct, timeAgo, formatClock, formatMac
    deviceLabel.js            category/os/model -> {label, group, icon} (see §3.3) — pure functions, unit-testable
    quality.js                latency -> {key, label} (see §3.5)
  src/composables/
    useStream.js              EventSource('/api/stream'), reconnect + backoff, connection state
    useTheme.js               'system' | 'dark' | 'light', localStorage 'netmon.theme'
    useAlarm.js               WebAudio beeps, title prefix, favicon swap, Notifications (see §5)
    useNow.js                 shared reactive `now` ticking every 1s (for "12m ago" text)
    useToasts.js              toast queue
  src/components/
    TopBar.vue  AlertStack.vue  ToastStack.vue  BackendBanner.vue
    KpiRow.vue  KpiCard.vue  InternetStatusCard.vue  IspCard.vue
    SpeedPanel.vue (chart + run test)  SpeedChart.vue  SpeedTestButton.vue
    CompositionStrip.vue
    DevicesPanel.vue  DevicesToolbar.vue  DevicesTable.vue  DeviceRow.vue  DeviceCard.vue (mobile)
    DeviceTypeIcon.vue  ConfidenceDot.vue  EvidencePopover.vue  QualityBadge.vue  Sparkline.vue
    EventsPanel.vue
    SaveDeviceModal.vue  ConfirmDialog.vue  SettingsDrawer.vue  TypeSelect.vue
    ui/Icon.vue  ui/Button.vue  ui/IconButton.vue  ui/Badge.vue  ui/Card.vue  ui/Modal.vue  ui/Drawer.vue
    ui/Popover.vue  ui/Tooltip.vue  ui/Switch.vue  ui/Segmented.vue  ui/Menu.vue  ui/Skeleton.vue  ui/Kbd.vue
```

No component library, no icon library, no chart library. Optional tiny deps allowed: none required.

---

## 1. Design tokens (`web/src/style.css`)

Strategy: Tailwind v4 `@theme` declares the **dark** values (dark is the default). Light mode overrides the *same CSS custom properties* on `:root[data-theme="light"]`. Because v4 utilities compile to `var(--color-…)`, every utility (`bg-surface`, `text-muted`, `border-border`, `bg-danger/15` …) re-themes automatically. Opacity modifiers (`/10`, `/15`, `/40`) are used for soft tints — Tailwind v4 implements them with `color-mix()`, so no separate "soft" tokens are needed except the `-fg` text variants.

Dark variant for the rare case it is needed: `@custom-variant dark (&:where([data-theme="dark"], [data-theme="dark"] *));` — prefer tokens over `dark:` utilities.

### 1.1 Neutral scale (reference palette, cool slate-gray)

Declared once in `@theme` as `--color-gray-*` (overrides Tailwind's gray) so they are available as raw utilities if ever needed; semantic tokens below are what components use.

| Token | Hex |
|---|---|
| `--color-gray-0`   | `#FFFFFF` |
| `--color-gray-25`  | `#F6F7F9` |
| `--color-gray-50`  | `#F1F3F6` |
| `--color-gray-100` | `#E9ECF0` |
| `--color-gray-200` | `#E3E6EB` |
| `--color-gray-300` | `#CDD2DA` |
| `--color-gray-400` | `#9AA4B2` |
| `--color-gray-500` | `#7D8796` |
| `--color-gray-600` | `#5F6878` |
| `--color-gray-700` | `#3A424E` |
| `--color-gray-750` | `#2F3742` |
| `--color-gray-800` | `#232931` |
| `--color-gray-850` | `#1C2128` |
| `--color-gray-900` | `#161A20` |
| `--color-gray-925` | `#111418` |
| `--color-gray-950` | `#0B0D10` |

### 1.2 Semantic surface / text tokens

| Token (`--color-…`) | Dark (default, in `@theme`) | Light (`:root[data-theme="light"]`) | Use |
|---|---|---|---|
| `bg`            | `#0B0D10` | `#F6F7F9` | page background (`body`) |
| `surface`       | `#111418` | `#FFFFFF` | cards, table, top bar |
| `surface-2`     | `#161A20` | `#F1F3F6` | table header, inputs, KPI inner wells, code chips |
| `surface-3`     | `#1C2128` | `#E9ECF0` | hover row, pressed, selected chip |
| `overlay`       | `#161A20` | `#FFFFFF` | popovers, menus, modals, drawer |
| `border`        | `#232931` | `#E3E6EB` | default 1px hairlines |
| `border-strong` | `#2F3742` | `#CDD2DA` | input borders, dividers that must be seen |
| `text`          | `#E6E9EE` | `#0E1116` | primary text (≥ 14:1) |
| `muted`         | `#9AA4B2` | `#4B5563` | secondary text, labels (≥ 7:1) |
| `subtle`        | `#7D8796` | `#6A7383` | tertiary/meta text, axis labels (≥ 4.5:1 on `surface`) |
| `scrim`         | `rgb(5 7 10 / 0.64)` | `rgb(15 23 42 / 0.32)` | modal/drawer backdrop |

`subtle` must not go lower than these values; it is the floor for readable text (AA 4.5:1 on `surface` and `surface-2`). Never use `gray-600`/`gray-700` for text in dark mode.

### 1.3 Accent and semantic state colors

Each state has a **base** (fills, dots, lines, icon color, and source for `/10`–`/20` soft backgrounds) and an **`-fg`** (text placed on a soft background or on `surface`, tuned for AA).

| Token | Dark base | Dark `-fg` | Light base | Light `-fg` | Meaning |
|---|---|---|---|---|---|
| `accent`  | `#6E7BF2` | `#A9B1FF` | `#4F46E5` | `#4338CA` | primary buttons, links, focus ring, Download series, selection |
| `success` | `#22C55E` | `#4ADE80` | `#16A34A` | `#15803D` | online, internet up, Excellent quality, restored |
| `warning` | `#F59E0B` | `#FBBF24` | `#D97706` | `#B45309` | slow internet, Fair quality, threshold line |
| `danger`  | `#EF4444` | `#F87171` | `#DC2626` | `#B91C1C` | internet down, Poor quality, packet loss, destructive |
| `info`    | `#38BDF8` | `#7DD3FC` | `#0284C7` | `#0369A1` | info alerts, Upload series, new device |

Additional: `--color-accent-contrast: #FFFFFF` (text on solid accent buttons, both themes). Good quality uses `success` at reduced emphasis (see §3.5), so there is no separate "good" hue.

### 1.4 Device category tints (icon tiles only)

Five groups + unknown. The tint is used **only** for the device-type icon tile (`bg-cat-x/12` tile, `text-cat-x` icon) and for the matching composition chip dot. Never for status.

| Group key | Token | Dark | Light | Categories in group |
|---|---|---|---|---|
| `computers` | `--color-cat-computer` | `#60A5FA` | `#2563EB` | computer, laptop, server, nas |
| `mobile`    | `--color-cat-mobile`   | `#A78BFA` | `#7C3AED` | phone, tablet, wearable |
| `network`   | `--color-cat-network`  | `#2DD4BF` | `#0D9488` | router, access_point, network_switch |
| `media`     | `--color-cat-media`    | `#F472B6` | `#DB2777` | tv, media_player, speaker, console |
| `iot`       | `--color-cat-iot`      | `#FB923C` | `#EA580C` | printer, camera, smart_home |
| `unknown`   | `--color-cat-unknown`  | `#8B95A5` | `#6A7383` | unknown |

Tile: 32×32 (desktop) / 36×36 (mobile card), `rounded-md`, `bg-cat-x/12` (dark) — light mode uses `/10`. Icon 18px, `text-cat-x`. A device that is offline renders its tile in `bg-surface-3 text-subtle` (tint removed) so offline rows read as dimmed.

### 1.5 Radii, shadows, spacing, z-index

```
--radius-sm: 6px     badges, chips, inputs-small, sparkline wells
--radius-md: 8px     buttons, inputs, icon tiles, menu items
--radius-lg: 12px    cards, table container, popovers, toasts
--radius-xl: 16px    modals, drawer inner corners
(full for pills/dots)
```

Shadows (dark relies on borders; shadows are for floating layers only):

| Token | Dark | Light |
|---|---|---|
| `--shadow-card`    | `0 0 0 1px rgb(255 255 255 / 0.02)` | `0 1px 2px rgb(16 24 40 / 0.05)` |
| `--shadow-popover` | `0 8px 24px rgb(0 0 0 / 0.45), 0 0 0 1px rgb(255 255 255 / 0.04)` | `0 8px 24px rgb(16 24 40 / 0.12), 0 2px 6px rgb(16 24 40 / 0.06)` |
| `--shadow-modal`   | `0 24px 64px rgb(0 0 0 / 0.6)` | `0 24px 64px rgb(16 24 40 / 0.18)` |
| `--shadow-glow-danger` | `0 0 0 1px rgb(239 68 68 / 0.5), 0 0 24px rgb(239 68 68 / 0.35)` | `0 0 0 1px rgb(220 38 38 / 0.45), 0 0 20px rgb(220 38 38 / 0.2)` |

Spacing: Tailwind default 4px scale. Card padding `p-4` (16px), KPI cards `p-4 lg:p-5`. Grid gap `gap-4` (mobile) / `gap-4 xl:gap-5`. Page gutter `px-4` (mobile, 16px) / `px-6` (≥768) / `px-8` (≥1536). Max content width `max-w-[1600px] mx-auto`.

Z-index: top bar 30, alert stack 29 (sticky under top bar), popover/menu 40, drawer 50, modal 60, toast 70, tooltip 80.

### 1.6 Typography

- Family: `--font-sans: "Inter", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;` with `font-feature-settings: "cv02","cv03","cv04","cv11";` on `body`.
- Mono: `--font-mono: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace;` (MAC addresses only, and the public IP).
- **All numbers use `tabular-nums`** (`font-variant-numeric: tabular-nums` applied on `body`, so it is global; IPs, Mbps, ms, %, times all align).
- Body `14px/20px`, color `text`, `-webkit-font-smoothing: antialiased`.

| Role | Size / line | Weight | Tracking | Tailwind |
|---|---|---|---|---|
| KPI value | 28/32 (mobile 24/28) | 600 | -0.02em | `text-[28px] leading-8 font-semibold tracking-tight` |
| KPI unit (Mbps, ms) | 13/16 | 500 | 0 | `text-[13px] text-muted` |
| Page/brand | 15/20 | 600 | -0.01em | |
| Section title | 13/20 | 600 | 0 | `text-[13px] font-semibold` |
| Eyebrow / KPI label / table header | 11/16 | 500 | 0.06em uppercase | `text-[11px] font-medium uppercase tracking-[0.06em] text-subtle` |
| Table body primary | 13/18 | 500 | 0 | |
| Table body secondary | 12/16 | 400 | 0 | `text-xs text-muted` |
| Badge | 11/16 | 500 | 0.01em | |
| Button | 13/20 | 500 | 0 | |
| Modal title | 16/24 | 600 | -0.01em | |

### 1.7 Theme handling

- `useTheme`: preference stored in `localStorage['netmon.theme']` ∈ `system | dark | light`, default `system`. Resolved theme written to `document.documentElement.dataset.theme = 'dark' | 'light'` and `style.colorScheme`.
- `system` follows `matchMedia('(prefers-color-scheme: dark)')` live; if the media query is unavailable, resolve to `dark`.
- Inline script in `index.html` `<head>` sets `data-theme` before first paint (no flash). All `localStorage` access in try/catch.
- Top bar toggle cycles `dark → light → system` (icon: moon / sun / monitor; tooltip says which). Settings drawer has a 3-way segmented control for the same value.
- `body { background: var(--color-bg); color: var(--color-text); }` explicitly.

### 1.8 Keyframes (in `style.css`)

`nm-pulse-danger` (box-shadow/background breathing for down banner, 1.6s ease-in-out infinite), `nm-ping` (live dot halo: scale 1→2.2, opacity .6→0, 1.8s cubic-bezier(0,0,.2,1) infinite), `nm-shimmer` (skeleton gradient sweep 1.4s linear infinite), `nm-flash` (row highlight `info/14%` → transparent over 2.4s), `nm-toast-in` (translateY 8px + opacity 0 → 0, 180ms), `nm-spin` (1s linear).

---

## 2. Layout

### 2.1 Page structure (top to bottom)

1. **TopBar** (sticky, 56px, `bg-surface/85 backdrop-blur border-b border-border`)
2. **BackendBanner** (only when SSE disconnected > 3s)
3. **AlertStack** (sticky beneath top bar; 0–3 banners)
4. **KPI row**: Internet status · Download · Upload · Ping/Jitter · ISP
5. **Speed panel** (history chart + Run speed test) and **Events panel** side-by-side on desktop
6. **Devices panel**: header with Network composition strip (type chips = filters), toolbar (status tabs, type filter, search, sort), table
7. Footer line (`text-xs text-subtle`): "NetMon · scanning 192.168.1.0/24 every 30s · data stays on this machine"

Toasts are fixed bottom-right (desktop) / bottom full-width (mobile).

### 2.2 Desktop (≥1280px) — 12-column grid

```
┌──────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│ ◆ NetMon   │ en0 · 192.168.1.0/24 · gw 192.168.1.1     [MOCK]        ● Live   ☾   🔔   ⚙                  │ TopBar 56px
├──────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ ▲ Internet is down since 10:42 · retrying every 5s                      [Enable sound] [Mute]          │ critical (pulsing)
│ ! Internet speed below 200 Mbps — 143 Mbps measured at 10:40              [Run test again]  ✕          │ warning
├──────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ ┌INTERNET────────┐ ┌DOWNLOAD────────┐ ┌UPLOAD──────────┐ ┌PING · JITTER───┐ ┌ISP──────────────────────┐ │
│ │ ● Online       │ │ 452.3 Mbps     │ │ 41.8 Mbps      │ │ 11 ms  ± 2 ms  │ │ Comcast Cable Comm…     │ │ KPI row
│ │ up 3h 12m      │ │ ▲ 3% vs prev   │ │ ▼ 1% vs prev   │ │ loss 0%        │ │ AS7922 · San Jose, US   │ │ 5 cols
│ │ checked 2s ago │ │ 10:40 · ≥200 ✓ │ │ 10:40          │ │ ▁▂▁▁▃▁▁ 5s     │ │ IP 73.•••.•••.12 👁 SJC │ │ ~116px
│ └────────────────┘ └────────────────┘ └────────────────┘ └────────────────┘ └─────────────────────────┘ │
│ ┌Speed history ─────────────── 6h 24h [7d] All ── [▶ Run speed test]┐ ┌Events ───────── All Dev Net ┐ │
│ │ 600┤                                     ● Download ● Upload ┄ 200 │ │ ▲ Internet down       10:42  │ │
│ │ 400┤ ●──●───●──●─────●───●──●                                   │ │ ● Living Room TV off  10:31  │ │ col-span-8
│ │ 200┤┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄●┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄ 200 Mbps│ │ ＋ New device: Pixel 8 10:20  │ │ + col-span-4
│ │   0┤ ●─●──●─●──●──●──●─●──●─●                                   │ │ ⚡ Speed test 452/42   10:05  │ │ height 320
│ │     08:00     12:00     16:00     20:00     00:00     04:00     │ │ …                 View all ▾ │ │
│ └──────────────────────────────────────────────────────────────────┘ └─────────────────────────────┘ │
│ ┌Devices  12 ──────────────────────────────────────────────────────────────────────────────────────────┐ │
│ │ [4 Computers] [3 Phones & tablets] [2 Network] [2 Media] [1 IoT & printers] [0 Unknown]  Clear     │ │ composition
│ │ All 12 · Online 10 · Offline 2 · Saved 4 · New 1     [Type: All ▾]  [🔍 Search name, IP, MAC  / ] ⇅ │ │ toolbar
│ │ ─────────────────────────────────────────────────────────────────────────────────────────────────── │ │
│ │ ST  DEVICE                                    IP            MAC                LATENCY        LOSS  THROUGHPUT   LAST SEEN  ⋯ │
│ │ ●  [▭] Jon's MacBook  This device  ★          192.168.1.23  a4:83:e7:1c:2d:9f  4 ms ▁▂▁ Exc  0%    ↓12.4 ↑1.1   now      ⋯ │
│ │        Mac · MacBook Pro · Apple  ●  Why?                                                                    │
│ │ ●  [⌂] Router  Gateway                        192.168.1.1   …                   2 ms ▁▁▁ Exc  0%    —            now      ⋯ │
│ │ ○  [▭] Living Room TV ★  (dimmed)             192.168.1.40  …                   —              —     —        Offline · 12m ago │
│ └──────────────────────────────────────────────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

Grid: `grid grid-cols-12 gap-4 xl:gap-5`. KPI row is its own `grid grid-cols-5` (ISP card same width as others at 1280; at ≥1536 use `grid-cols-[repeat(4,minmax(0,1fr))_minmax(0,1.35fr)]` so ISP gets more room). Speed panel `col-span-8`, Events `col-span-4`, both `h-[320px]` (events list scrolls inside). Devices panel `col-span-12`.

### 2.3 Tablet (768–1279px)

```
┌────────────────────────────────────────────────────────────────┐
│ ◆ NetMon  192.168.1.0/24          ● Live  ☾  🔔  ⚙             │
├────────────────────────────────────────────────────────────────┤
│ [alert banners]                                                │
│ ┌INTERNET──────┐ ┌DOWNLOAD─────┐ ┌UPLOAD──────┐                │ KPI: grid-cols-3
│ └──────────────┘ └─────────────┘ └────────────┘                │
│ ┌PING · JITTER─┐ ┌ISP (spans 2) ─────────────────┐             │ row 2: 1 + 2
│ └──────────────┘ └───────────────────────────────┘             │
│ ┌Speed history (full width, h 280) ─────────── [Run test]┐     │
│ └────────────────────────────────────────────────────────┘     │
│ ┌Devices ────────────────────────────────────────────────┐     │
│ │ chips (horizontal scroll if needed)                     │     │
│ │ tabs · type · search                                    │     │
│ │ ST DEVICE                IP           LATENCY   LAST ⋯  │     │ MAC, LOSS, THROUGHPUT columns hidden;
│ │ ...                                                     │     │ MAC shown on 2nd line of IP cell
│ └─────────────────────────────────────────────────────────┘     │
│ ┌Events (collapsible, default open, max-h 360) ───────────┐     │
└────────────────────────────────────────────────────────────────┘
```

Breakpoints (Tailwind defaults): `md` 768, `lg` 1024, `xl` 1280, `2xl` 1536. Between `lg` and `xl` LOSS column returns; THROUGHPUT and full MAC column return at `xl`.

### 2.4 Mobile (360–767px)

```
┌──────────────────────────────────┐
│ ◆ NetMon         ● Live  ☾  ⋯   │  ⋯ = menu: Mute, Settings, subnet info
├──────────────────────────────────┤
│ ▲ Internet down since 10:42      │  banners: full width, copy shortened,
│   retrying every 5s     [Mute]   │  actions wrap below text
├──────────────────────────────────┤
│ ┌INTERNET─────┐ ┌PING──────────┐ │  KPI: grid-cols-2, value 24px
│ │ ● Online    │ │ 11 ms ±2     │ │
│ └─────────────┘ └──────────────┘ │
│ ┌DOWNLOAD─────┐ ┌UPLOAD────────┐ │
│ │ 452 Mbps    │ │ 41.8 Mbps    │ │
│ └─────────────┘ └──────────────┘ │
│ ┌ISP (col-span-2) ─────────────┐ │
│ └──────────────────────────────┘ │
│ [▶ Run speed test] (full width)  │
│ ┌Speed history h180 ───────────┐ │  range tabs: 24h / 7d / All
│ └──────────────────────────────┘ │
│ Devices 12                        │
│ ‹[4 Computers][3 Phones][2 Net]›  │  chips: horizontal scroll, snap
│ [All 12][Online 10][Offline 2]… › │  tabs: horizontal scroll
│ [🔍 Search            ] [Type ▾]  │
│ ┌──────────────────────────────┐ │  DeviceCard
│ │[▭] Jon's MacBook   ● Online ⋯│ │
│ │    Mac · MacBook Pro  This dev│ │
│ │    192.168.1.23 · Apple       │ │
│ │    4 ms ▁▂▁  Excellent · 0%   │ │
│ │    ↓ 12.4  ↑ 1.1 Mbps         │ │  (self only)
│ └──────────────────────────────┘ │
│ ▸ Events (collapsed accordion)    │
└──────────────────────────────────┘
```

Rules: 16px side gutter, no horizontal page scroll (chip and tab rows scroll internally with `overflow-x-auto`, `scrollbar-width: none`, edge fade masks). Tap targets ≥ 40px. The subnet text moves into the ⋯ menu. Toasts full width at bottom with 12px inset, above the iOS home indicator (`env(safe-area-inset-bottom)`).

---

## 3. Components

### 3.1 TopBar

Left: logo mark (20px rounded-md square `bg-accent` with a white 3-node "network" glyph) + "NetMon" (15/600). Divider. Network context (`text-[13px] text-muted`, tabular): `en0 · 192.168.1.0/24 · gw 192.168.1.1` (≥ md); on hover tooltip shows interface name, self IP, self MAC.

If server reports mock mode: Badge `MOCK DATA` (`bg-warning/15 text-warning-fg`), tooltip "Showing simulated devices (NETMON_MOCK=1)".

Right cluster (IconButtons, 32×32, `rounded-md`, `text-muted hover:text-text hover:bg-surface-3`):
- **Live status** (not a button): 8px dot + label. `Live` = `success` dot with `nm-ping` halo; `Reconnecting…` = `warning` dot, no halo; `Offline` = `danger` dot. `data-testid="sse-status"`, `aria-label="Live updates: connected"`.
- **Theme toggle** (`theme-toggle`): moon/sun/monitor.
- **Mute** (`mute-toggle`): `bell` ↔ `bell-off`. Session-level mute of sounds (does not change the saved setting). When an alarm is sounding the button gets `text-danger` and a 1px `danger/40` ring so it is easy to find. Shortcut `M`.
- **Settings** (`settings-btn`): gear, opens SettingsDrawer. Shortcut `,`.

### 3.2 KPI cards

Card: `bg-surface border border-border rounded-lg shadow-card p-4 lg:p-5`, min-height 116px. Structure: eyebrow label row (icon 14px `text-subtle` + LABEL) → value row → meta row (`text-xs text-muted`).

- **Internet status** (`kpi-internet-status`): Online → big text "Online" `text-success-fg`, 10px solid dot; meta "Up 3h 12m · checked 2s ago". Down → card gets `border-danger/50 bg-danger/8`, text "Down" `text-danger-fg`, meta "Since 10:42 (6m) · 2 failed probes". Checking/unknown (no data yet) → "Checking…" `text-muted` with spinner icon. Slow (up but below threshold) → "Online" plus Badge `Slow` warning.
- **Download** (`kpi-download`): value `452.3` + unit `Mbps` (one decimal <1000, integer ≥1000; ≥1000 renders `1.21 Gbps`). Meta: delta vs previous test (`▲ 3%` success-fg / `▼ 12%` danger-fg if drop >10% else muted) · test time `10:40`. A 2px bottom bar inside the card shows value vs threshold: fill `accent` when ≥ threshold, `warning` when below, with a 1px tick at the threshold position and label `200` in `text-subtle`. Below threshold: value turns `text-warning-fg`, card border `warning/40`.
  - While a speed test runs: value is the **live** Mbps from progress events, label shows `Testing…` with `nm-spin` icon, value has `opacity-80`, bottom bar becomes progress (0–100%). Upload card does the same during the upload phase.
- **Upload** (`kpi-upload`): same as download, no threshold bar.
- **Ping · Jitter** (`kpi-ping`): value `11 ms` with `± 2 ms` jitter in 15px muted beside it; meta "loss 0% · from last test" plus a 64×16 sparkline of the internet probe latency (last 60 probes). Value color by quality thresholds (§3.5).
- **ISP** (`kpi-isp`): line 1 organization (15/600, truncate with title tooltip), e.g. "Comcast Cable Communications"; line 2 `AS7922 · San Jose, US` muted; line 3 `Public IP 73.•••.•••.12` in mono with eye IconButton to reveal (state in memory only), and `via SJC` badge (Cloudflare colo). Loading: skeleton lines. Error: "ISP unavailable" muted + retry link.

Empty state before the first speed test: Download/Upload show `—` with meta "No test yet · [Run now]" link.

### 3.3 Device presentation (`deviceLabel.js`)

Inputs: `category`, `os`, `model`, `isGateway`, `vendor`. Output: `{ label, group, icon, categoryLabel }`.

**Family label table** (category × os → family):

| category | os | family label |
|---|---|---|
| computer / laptop | macos | `Mac` |
| computer | windows | `Windows PC` |
| laptop | windows | `Windows laptop` |
| computer / laptop | linux | `Linux PC` |
| computer / laptop | chromeos | `Chromebook` |
| computer / laptop | other/null | `Computer` / `Laptop` |
| phone | ios | `iPhone` |
| phone | android | `Android phone` |
| phone | other/null | `Phone` |
| tablet | ipados | `iPad` |
| tablet | android | `Android tablet` |
| tablet | other/null | `Tablet` |
| wearable | any | `Watch` (`Apple Watch` if ios/vendor Apple) |
| router | — | `Router (gateway)` if `isGateway`, else `Router` |
| access_point | — | `Wi-Fi access point` |
| network_switch | — | `Network switch` |
| tv | — | `Smart TV` (`Apple TV` if tvos) |
| media_player | — | `Streaming device` (`Apple TV` if tvos) |
| speaker | — | `Smart speaker` |
| printer | — | `Printer` |
| camera | — | `Camera` |
| console | — | `Game console` |
| nas | — | `NAS` |
| server | linux | `Linux server` |
| server | other | `Server` |
| smart_home | — | `Smart-home device` |
| unknown | — | `Unknown device` |

**Combining with model** (model is already a friendly name from the backend, e.g. `MacBook Pro`, `iPhone 15 Pro`, `Chromecast`, `Sonos One`, `eero Pro 6`):
1. No model → `family`.
2. Model starts with the family word (case-insensitive: `iPhone 15 Pro` vs `iPhone`, `iPad Air` vs `iPad`, `Apple TV 4K` vs `Apple TV`) → `model` alone.
3. Category is media_player / speaker / console / wearable and model is a product name → `model` alone (`Chromecast`, `Sonos One`, `PlayStation 5`, `HomePod mini`).
4. Otherwise → `family · model` (`Mac · MacBook Pro`, `Wi-Fi access point · eero Pro 6`, `Printer · HP LaserJet M404`, `NAS · Synology DS920+`, `Android phone · Galaxy S23`).

Required outputs for mock devices: `Mac · MacBook Pro`, `Router (gateway)`, `Windows PC`, `iPhone`, `Android phone · Pixel 8` (or `Android phone`), `Wi-Fi access point · …`, `Smart TV · …`, `Printer · …`, `Sonos One`, `Unknown device` / `Smart-home device`.

**Category → icon** (Icon.vue names): computer `monitor`, laptop `laptop`, server `server`, nas `hard-drive`, phone `smartphone`, tablet `tablet`, wearable `watch`, router `router`, access_point `wifi`, network_switch `network`, tv `tv`, media_player `cast`, speaker `speaker`, console `gamepad`, printer `printer`, camera `camera`, smart_home `home`, unknown `help-circle`.

**Display name priority** (row primary text): saved `name` → mDNS/NetBIOS/UPnP friendly name → hostname (strip `.local`, `.lan`, `.home`) → `label` → IP. Secondary line: `label` · `vendor` (vendor omitted if empty or already contained in label). If the primary text is the hostname and a saved name exists, hostname appears in the secondary line instead: `Mac · MacBook Pro · jons-mbp.local`.

### 3.4 Devices table (`DevicesTable.vue`, `data-testid="devices-table"`)

Container: Card with no inner padding, `overflow-hidden`; table scrolls horizontally inside the card only if needed (`overflow-x-auto`), never the page. Header row `bg-surface-2`, 36px, eyebrow style; sticky within the panel (`sticky top-[56px]` under top bar when page scrolls). Body rows 56px (two-line device cell), `border-t border-border`, `hover:bg-surface-3/60`. Row `data-testid="device-row"` with `data-mac="aa:bb:…"`, `data-online="true|false"`, `data-saved`, `data-category`.

| # | Column | Width | Content |
|---|---|---|---|
| 1 | Status | 40px | 8px dot: online `success`; offline `gray-500` hollow ring (1.5px); new (first seen < 10 min, unsaved) online dot + small `info` "New" badge after name. `aria-label="Online"` / "Offline". |
| 2 | Device | flex (min 280) | `DeviceTypeIcon` tile · **Line 1**: display name (13/500, truncate) + badges: `This device` (accent soft), `Gateway` (network tint soft), `★` saved (filled star `text-warning`, 12px, title "Saved"), `New` (info soft). **Line 2** (12px muted): label · vendor · `ConfidenceDot` · `Why?` link-button (12px `text-subtle hover:text-accent-fg underline-offset-2`). |
| 3 | IP | 128px | IP tabular 13px; sortable numerically. Copy-on-click (tooltip "Copy IP" → "Copied"). |
| 4 | MAC | 172px | Mono 12px muted, lowercase colon form. If locally administered: Badge `Private` (`shield` icon 12px, `bg-surface-3 text-muted`) with tooltip "Private (randomized) Wi-Fi address — common on iPhone, Android and Windows. It may change if the device forgets this network." `data-testid="private-mac-badge"`. |
| 5 | Latency | 200px | `12 ms` (13/500, colored by quality fg) + `± 3` jitter muted 11px + `Sparkline` 72×20 + `QualityBadge`. Offline → `—`. |
| 6 | Loss | 64px | `0%` muted; `>0 and <5%` warning-fg; `≥5%` danger-fg. Rolling window (tooltip "Packet loss over last 30 pings"). |
| 7 | Throughput | 128px | Self only: `↓ 12.4  ↑ 1.1` Mbps, tiny live arrows in accent/info. Others: `—` in `text-subtle` with Tooltip **"Requires router integration"** (`data-testid="throughput-na"`). |
| 8 | Last seen | 120px | Online → `now` (if seen < 15s) else `12s ago`. Offline → `Offline · 12m ago` in muted (`timeAgo` ticking via `useNow`); full timestamp in title tooltip. |
| 9 | Actions | 88px | Unsaved: Button ghost sm `bookmark-plus` "Save" (`save-device-btn`). Saved: IconButton `pencil` (Edit, opens modal) . Always: IconButton `more-horizontal` → Menu: Edit/Save…, Copy IP, Copy MAC, Re-detect type (if API exists), separator, Forget device (danger; saved only). |

**Offline saved rows**: entire row `opacity-60` except the actions column (full opacity so it stays usable), type tile de-tinted, latency/loss/throughput `—`, last seen `Offline · 12m ago`. They sort below online rows by default. Unsaved devices that go offline remain visible in the Offline tab for the server-defined retention, same styling.

**Device appearing** (SSE new device): row inserted with `nm-flash` highlight; it does not steal scroll position.

**Filter tabs** (`filter-tab-all|online|offline|saved|new`): `All 12 · Online 10 · Offline 2 · Saved 4 · New 1`, Segmented-style underline tabs, counts in `text-subtle` tabular pill. Active tab `text-text` with 2px accent underline. Tab counts reflect the **type-filtered + searched** set, so numbers always match what the user would see.

**Type filter**: (a) composition chips (§3.6) and (b) a `Type: All ▾` dropdown in the toolbar (listbox with icon + label + count, multi-select checkboxes, "All types" reset). Both edit the same state; chips toggle group-level filters, the dropdown allows individual categories.

**Search** (`search-input`): placeholder "Search name, IP, MAC, vendor…". Matches (case-insensitive substring) name, hostname, label, model, vendor, IP, MAC (with or without separators). Shortcut `/` focuses; `Esc` clears. Result empty → inline empty state (§6).

**Sort**: clickable headers Device (name), IP, Latency, Loss, Last seen; `aria-sort` on `<th>`; chevron icon. Default sort ("Smart"): online first → gateway → this device → saved → others; ties by IP numeric. A `⇅ Sort` menu on tablet/mobile offers the same keys. Sort/filter/tab state persisted in `localStorage['netmon.devices.view']` (try/catch).

**Mobile card** (`DeviceCard.vue`, also `data-testid="device-row"`): 12px padding, `rounded-lg border bg-surface`, gap 8px between cards. Header: tile 36px · name + badges · status pill `● Online` / `Offline · 12m ago` right · ⋯ menu. Lines: label · vendor · confidence · Why?; `IP · MAC(+Private)`; latency + sparkline + quality + loss; throughput (self only). Tap card (not on controls) opens the save/edit modal.

### 3.5 Quality badge (`quality.js`, `QualityBadge.vue`)

Based on median latency of the rolling window, overridden by loss:

| Key | Rule | Label | Style |
|---|---|---|---|
| excellent | < 20 ms and loss < 1% | Excellent | `bg-success/15 text-success-fg` |
| good | < 50 ms and loss < 2% | Good | `bg-success/8 text-success-fg/80`, border `success/20` |
| fair | < 100 ms or loss < 5% | Fair | `bg-warning/15 text-warning-fg` |
| poor | ≥ 100 ms or loss ≥ 5% | Poor | `bg-danger/15 text-danger-fg` |
| none | no samples / offline | — | none |

Badge: height 20, px-1.5, `rounded-sm`, 11/500. Tooltip: "Median 12 ms · jitter 3 ms · loss 0% (last 30 pings)".

### 3.6 Network composition strip (`CompositionStrip.vue`)

Lives in the Devices panel header, above the toolbar. Title row: "Devices" (section title) + total count pill + right-aligned summary text `4 computers · 3 phones · 2 network · 2 media · 1 IoT` (muted, ≥ lg only).

Chips (`type-chip-computers|mobile|network|media|iot|unknown`), one per group with count > 0 (Unknown always last, hidden if 0): `[icon] 4 Computers`. 32px tall, `rounded-md border border-border bg-surface-2 px-2.5`, icon in group tint, count tabular 600. Pressed/active: `bg-cat-x/12 border-cat-x/40 text-text`, `aria-pressed="true"`. Multiple chips may be active (OR). "Clear" text button appears when any is active. Counts are of all devices currently known (online + saved offline), with offline share shown as a tiny `· 1 off` muted suffix when >0.

Optional proportional bar (≥ lg): 4px tall full-width stacked bar under the chips, segments colored by group tint at 70% opacity, 2px gaps, rounded ends — gives the at-a-glance composition.

Group labels (plural / singular): Computers/Computer, Phones & tablets/Phone or tablet, Network/Network device, Media/Media device, IoT & printers/IoT device, Unknown/Unknown.

### 3.7 Type icon, confidence, "Why?" evidence

**DeviceTypeIcon**: tile per §1.4. If `typeSource === 'user'`, a 10px `pencil` glyph badge sits bottom-right of the tile (`bg-overlay` circle with border) — tooltip "Type set by you".

**ConfidenceDot** (6px, inline after label, with sr-only text):
- `typeSource === 'user'` → no dot (pencil on tile instead).
- ≥ 0.8 → solid `success` dot, tooltip "High confidence (92%)".
- 0.5–0.79 → solid `warning` dot at 80% opacity, "Medium confidence (64%)".
- < 0.5 → 1.5px hollow `gray-500` ring, "Low confidence — best guess (31%)". Label text also gets a trailing `?` in subtle: `Unknown device`, or `Smart-home device?`.

**EvidencePopover** (`data-testid="evidence-popover"`, trigger `device-why`): Popover anchored to the Why? button, 320px wide, `bg-overlay rounded-lg shadow-popover border border-border p-3`.
```
┌─────────────────────────────────────────┐
│ [▭] Mac · MacBook Pro                   │  13/600
│ Detected automatically · 92% confidence │  12 muted; 4px meter bar under it (accent fill)
│ ─────────────────────────────────────── │
│ ✓ mDNS model MacBookPro18,3             │  each evidence line: 12px, check icon `success`
│ ✓ Vendor Apple (OUI a4:83:e7)           │  in muted text, max 8 lines, scroll beyond
│ ✓ TTL 64 → Unix-like                    │
│ ✓ Port 548 open → macOS file sharing    │
│ ─────────────────────────────────────── │
│ Wrong?  [Change type]                    │  opens Save/Edit modal focused on Type select
└─────────────────────────────────────────┘
```
User-set: header line "Set by you" + "Auto-detect would say: Windows PC (71%)" if available, and the evidence list. No evidence: "Not enough information yet. Detection improves as the device responds to discovery." Opens on click and on keyboard Enter/Space; closes on Esc, outside click, or scroll; focus moves into popover and returns to trigger. `role="dialog" aria-label="Why this device type"`.

### 3.8 Speed panel (`SpeedPanel.vue`)

Header: "Speed history" title · range Segmented `6h | 24h | 7d | All` (default 24h; mobile hides 6h) · legend (≥ md) · `SpeedTestButton`.

**SpeedTestButton** (`run-speedtest`): primary button `▶ Run speed test`, 32px. States:
- idle → enabled; tooltip "Last test 10:40 · next automatic test in 9m".
- running (from user or auto, driven by SSE progress) → button replaced inline by a progress pill `data-testid="speedtest-progress"`, 200px wide: phase text + percentage + 3px bar.
  - `Measuring latency…` → `Download · 62% · 412 Mbps` → `Upload · 30% · 38 Mbps` → `Finishing…`
  - bar fill accent during download, info during upload; `aria-live="polite"` (announce phase changes only, not every percent); `role="progressbar" aria-valuenow`.
- just finished → for 3s shows `✓ 452 / 42 Mbps` success-fg, then back to idle.
- error → `Speed test failed · Retry` danger-fg text button, plus an event entry.
- internet down → disabled, tooltip "Internet is down".
Only one test at a time: if the server reports a test running, the button shows progress regardless of who started it.

### 3.9 SpeedChart (custom SVG)

- Size: width = container (ResizeObserver, debounced to rAF), height 220 (desktop, inside the 320 panel), 200 tablet, 180 mobile. Padding: left 44, right 16, top 12, bottom 24.
- Data: speed history points `{ts, downloadMbps, uploadMbps, pingMs, ok}` filtered by range. X = time (linear between range start and now; for `All`, between first point and now).
- Y scale: 0 → `niceCeil(max(maxDownload, threshold) × 1.15)`; nice steps from {1,2,2.5,5}×10ⁿ; 4–5 ticks. Labels left, 11px `subtle`, tabular, `Mbps` unit only on top tick (`600 Mbps`). Gridlines 1px `border` (solid, horizontal only). X ticks: 4–6 time labels (`HH:mm` for ≤24h, `ddd HH:mm` / `MMM d` for longer), 11px subtle.
- **Threshold line**: horizontal at `speedThresholdMbps`, `stroke: warning`, 1.25px, `stroke-dasharray: 4 4`, opacity .9; right-end label pill `200 Mbps` (`bg-warning/15 text-warning-fg`, 10px/500, rounded-sm) drawn above the line inside plot area. Region below threshold gets a very faint `warning/4%` fill band.
- **Download series**: `accent` 2px polyline with round joins + area fill linear-gradient `accent 18% → 0%`. Points: circle r=3 `fill: surface` `stroke: accent` 1.5px; points below threshold: `fill: warning`, `stroke: warning`. Only connect consecutive points if gap < 3× the test interval; otherwise break the line.
- **Upload series**: `info` 1.5px polyline, no area, points r=2.5.
- **Failed tests / down**: `x` marker (6px, `danger`) at baseline; internet-down intervals (from events) shaded as `danger/8%` vertical bands with no label.
- **Hover/touch**: vertical crosshair 1px `border-strong`, nearest point snapping by x, enlarged point r=4.5, tooltip (overlay card 180px): `10:40 · Oct 17`, `● Download 452.3 Mbps`, `● Upload 41.8 Mbps`, `Ping 11 ms · SJC`, and `Below threshold` warning tag when applicable. Tooltip flips side near edges.
- **Keyboard**: `<svg role="img" tabindex="0" aria-label="Speed history, 24 tests, latest download 452 Mbps">`; ←/→ move the active point, Home/End jump, tooltip follows; Esc clears. A visually hidden `<table>` with the same data follows for screen readers.
- **Live**: when a new test result arrives, the new point animates in (r 0→3, 240ms) and the line extends; no full re-draw flash.
- **Empty**: centered "No speed tests yet" (13/500) + "Results appear here after the first test." + secondary Run button. **Loading**: skeleton (§6).

### 3.10 Sparkline (custom SVG)

- Sizes: 72×20 (table), 64×16 (Ping KPI), 96×24 (mobile card). `viewBox="0 0 W H"`, `preserveAspectRatio="none"`, `vector-effect: non-scaling-stroke`.
- Data: last 30 latency samples (~5 min at 10s); `null` = lost ping.
- Y: 0 → `max(20, p95 × 1.25)` ms so a quiet 3 ms device reads as flat-low, not as noise. 1px top/bottom inset.
- Stroke 1.5px in the quality color (`success`/`warning`/`danger`), area fill gradient same color 16% → 0%. Line breaks at nulls; each null draws a 1×4px `danger` tick at the bottom.
- Last sample: dot r=1.75 same color.
- Fewer than 2 samples → a 1px dashed `border-strong` baseline.
- `aria-hidden="true"`; the parent cell has sr-only text "Latency 12 ms, excellent".
- No animation except new-sample shift (none if reduced motion).

### 3.11 Events panel (`EventsPanel.vue`, `events-panel`)

Header: "Events" + Segmented filter `All | Devices | Internet | Speed`. List: newest first, rows 36px (`event-item`), `px-3`, hairline separators. Row: 16px icon in a 24px circle tinted by kind · message (13px, truncate, device names in 500 weight) · time right (`10:42` tabular subtle, tooltip full date + "6m ago").

| Kind | Icon | Tint | Message pattern |
|---|---|---|---|
| internet down | `wifi-off` | danger | Internet went down |
| internet restored | `wifi` | success | Internet restored after 6m 12s |
| speed test | `gauge` | accent (warning if slow) | Speed test · 452 ↓ / 42 ↑ Mbps · 11 ms |
| speed slow | `alert-triangle` | warning | Speed below 200 Mbps (143 Mbps) |
| device online | `arrow-up-circle`/`plug` | success | Living Room TV came online |
| device offline | `circle-off` | gray | Living Room TV went offline |
| new device | `plus-circle` | info | New device joined: iPhone (192.168.1.57) |
| device saved/renamed | `bookmark` | gray | Saved "Living Room TV" |

Days separated by sticky small headers ("Today", "Yesterday", "Oct 15"). Shows last 100, "Load older" button at end if server has more. Empty: "No events yet. Changes on your network will appear here."

---

## 4. Modals and drawer

All overlays use `ui/Modal.vue` / `ui/Drawer.vue`: Teleport to body, `scrim` backdrop with 120ms fade, focus trap, initial focus on first field (or the safest button for destructive dialogs), `Esc` closes, backdrop click closes (not for forms with unsaved edits → ask "Discard changes?" inline), body scroll lock, focus returns to the trigger. `role="dialog" aria-modal="true" aria-labelledby`.

### 4.1 Save / Edit device (`SaveDeviceModal.vue`, `save-modal`)

Width 480px (mobile: bottom sheet, full width, `rounded-t-xl`, max-h 90vh).
```
┌ Save device ───────────────────────────────── ✕ ┐
│ [▭]  Mac · MacBook Pro                           │ summary card: bg-surface-2 rounded-md p-3
│      192.168.1.23 · a4:83:e7:1c:2d:9f · Apple    │
│                                                  │
│ Name *                                           │
│ [ Jon's MacBook                              ]   │ save-name-input, autofocus, select-all
│ Shown everywhere instead of the hostname.        │ helper 12px muted
│                                                  │
│ Device type                                      │
│ [ ✦ Auto-detect — Mac · MacBook Pro (92%)   ▾ ]  │ save-type-select (TypeSelect listbox)
│                                                  │
│ Notes                                            │
│ [ Office desk, wired                          ]  │ textarea 3 rows, 280 chars, counter
│                                                  │
│ ─────────────────────────────────────────────── │
│ [Forget device]               [Cancel] [Save]    │ Forget only in edit mode (danger ghost, left)
└──────────────────────────────────────────────────┘
```
- Title: "Save device" (unsaved) / "Edit device" (saved).
- Name: required, trimmed, 1–40 chars; prefill = existing name, else friendly name/hostname, else label (e.g. "iPhone"). Error inline: "Give this device a name." (danger-fg 12px, input border danger, `aria-invalid`, `aria-describedby`).
- Saving explains the benefit for unsaved devices, helper under title: "Saved devices stay listed when they disconnect, so you'll know when they go offline."
- **TypeSelect** (custom listbox, `role="listbox"`, type-ahead, ↑/↓/Home/End/Enter/Esc): first option `✦ Auto-detect` with the current auto result in muted (`Mac · MacBook Pro · 92%`); then options grouped by the 5 groups + Unknown with group headers (11px eyebrow), each option = 16px icon in tint + category label (Computer, Laptop, Server, NAS / Phone, Tablet, Wearable / Router, Wi-Fi access point / mesh node, Network switch / TV, Streaming device, Speaker, Game console / Printer, Camera, Smart-home device / Unknown). Selected has check icon. Value `null` = auto.
- Footer: `Cancel` (secondary), `Save` (primary, `save-submit`, shows spinner while request in flight, disabled while invalid). `Enter` in name field submits; `⌘/Ctrl+Enter` submits from textarea.
- On success: modal closes, toast "Saved “Jon's MacBook”" (success), row updates in place with ★.
- On API error: inline error bar at top of modal body (danger soft) "Couldn't save. The server didn't respond — try again."

### 4.2 Forget confirm (`ConfirmDialog.vue`, `confirm-dialog`)

Width 400px, `role="alertdialog"`.
- Title: `Forget “Living Room TV”?`
- Body: "NetMon will stop tracking this device by name and won't alert you when it goes offline. Detected type information is kept; you can save it again anytime."
- Buttons: `Cancel` (initial focus) · `Forget device` (solid danger, `confirm-forget`).
- After: toast "Forgot “Living Room TV”" with `Undo` action (5s) which re-saves with the previous name/type/notes.

### 4.3 Settings drawer (`SettingsDrawer.vue`, `settings-drawer`)

Right-side drawer 400px (mobile: full-screen sheet), `bg-overlay border-l border-border`, slides in 240ms. Header "Settings" + ✕. Sections separated by hairlines, each field label 13/500 + 12px helper muted.

1. **Alerts**
   - *Speed alert threshold* (`setting-threshold`): number input with suffix `Mbps`, min 1, max 10000, step 10, width 140; helper "Show a warning when download speed is below this. Default 200 Mbps." Validates on blur.
   - *Sound alerts* (`setting-sound`): Switch; helper "Beep repeatedly while the internet is down." Inline `Test sound` link plays one beep (also unlocks audio).
   - *Desktop notifications* (`setting-notifications`): Switch; turning on calls `Notification.requestPermission()`; if denied → switch reverts and helper reads "Blocked by the browser — allow notifications for this site to enable." Stored in localStorage (browser-specific), not on the server.
2. **Speed tests**
   - *Automatic test interval* (`setting-interval`): select `Off · 5 · 10 · 15 · 30 · 60 minutes` (default 15). Helper "Each test downloads ~100 MB." (copy can be adjusted to actual size by the frontend from PLAN.md).
3. **Device detection**
   - *Active fingerprinting* (`setting-fingerprinting`): Switch, default on. Helper "Briefly probes common ports and NetBIOS on new devices to identify them. Turn off for passive detection only (mDNS, SSDP, vendor, hostname)."
4. **Appearance**: Theme Segmented `System | Dark | Light`.
5. **About** (muted): version, mode (`Live` / `Mock data`), data directory path, backend uptime.

Server-backed fields auto-save (debounce 400ms, `PUT/PATCH /api/settings` per PLAN.md); a small `✓ Saved` (success-fg 12px) fades in next to the field for 1.5s; on failure field reverts and shows inline error. No Save button.

---

## 5. Alarm UX (`AlertStack.vue`, `useAlarm.js`, `ToastStack.vue`)

Alerts come from the server (SSE). The client never invents alerts except connection loss to the backend (§6).

### 5.1 Banner stack

Sticky below the top bar, full content width, 8px gap, order by severity: critical → warning → info. Each banner: `rounded-lg border px-4 py-3`, leading 18px icon, message (14/500) + secondary text (13 muted), trailing actions. `data-testid="banner-internet-down" | "banner-slow" | "banner-devices-offline"`.

**Internet down — critical** (`role="alert"`, `aria-live="assertive"`, announced once on appearance):
- Style: `bg-danger/12 border-danger/50 text-danger-fg`, icon `alert-octagon`, animation `nm-pulse-danger` (box-shadow between `0 0 0 0 danger/0` and `--shadow-glow-danger`, background alpha 12%→18%, 1.6s, infinite). Reduced motion: static `bg-danger/16` + glow, no animation.
- Text: **"Internet is down since 10:42"** · "retrying every 5s" — live elapsed suffix `(6m 12s)` updated each second, last attempt time in tooltip.
- Actions: `Mute` (if sound playing) / `Enable sound` (if audio blocked by autoplay policy, see 5.3) · no dismiss (it clears itself when restored).
- Side effects while down: `document.title = "⚠ Internet down · NetMon"`; favicon swapped to `favicon-alert.svg` (red dot); Internet KPI card in down style; Speed test button disabled; repeating beep (5.3); one desktop Notification if enabled and the tab is hidden ("Internet is down — since 10:42").

**Slow — warning** (`role="status"`, polite):
- Style: `bg-warning/12 border-warning/40 text-warning-fg`, icon `alert-triangle`.
- Text: **"Internet speed below 200 Mbps — 143 Mbps measured at 10:40"** (threshold and value from data).
- Actions: `Run test again` (secondary sm) · dismiss ✕ (`banner-slow-dismiss`). Dismiss hides it until a *new* speed test result is below threshold again (track by test id/timestamp in memory). Clears automatically when a test ≥ threshold arrives (with success toast "Speed back above 200 Mbps — 452 Mbps").
- Title prefix when slow and not down: `▼ ` (`"▼ Slow internet · NetMon"`). One soft chime (5.3) per new slow result; no repeat.

**Saved devices offline — info** (polite):
- Style: `bg-surface border-border` with `info` icon `circle-off` (calm — this is not an emergency).
- Text: "2 saved devices offline: Living Room TV, Dad's iPad" (first 3 names, then "+2 more"). Action `Show` → applies Offline tab + Saved filter in the devices table and scrolls to it. Dismiss ✕ (until the offline set changes).

Max 3 banners; when more are relevant, info banners collapse first.

Normal title: `NetMon` (or `NetMon · 10 online` optional). Title prefixes stack in priority: down `⚠` beats slow `▼`.

### 5.2 Toasts

Bottom-right stack (desktop, 360px wide, 12px gap, max 4 visible, newer on top) / bottom full width (mobile). `rounded-lg bg-overlay border shadow-popover p-3`, left 3px accent bar in the semantic color, icon, title 13/600, body 12 muted, optional action, ✕. Auto-dismiss 6s (info/success), 10s (warning); hover/focus pauses timer. Container `aria-live="polite" role="status"`; each toast `data-testid="toast"` + `data-kind`.

| Trigger | Kind | Title | Body |
|---|---|---|---|
| Internet restored | success | Internet restored | Down for 6m 12s (10:42 – 10:48) |
| Saved device offline | info | Living Room TV went offline | Last seen 10:31 · 192.168.1.40 |
| Saved device back online | success | Living Room TV is back online | |
| New device joined | info | New device joined | iPhone · 192.168.1.57 · Apple — [Save] action opens modal |
| Speed test done (manual only) | success / warning | Speed test complete | 452 ↓ / 42 ↑ Mbps · 11 ms |
| Save/forget feedback | success | Saved “…” / Forgot “…” [Undo] | |
| Request errors | danger | Couldn't reach NetMon server | action Retry |

Collapse bursts: ≥3 device events within 2s become one toast "3 devices went offline" with names in body.

### 5.3 Sound (`useAlarm.js`)

- Single shared `AudioContext`, created lazily; `resume()` is attempted on the first `pointerdown`/`keydown` anywhere (one-time listeners). If an alarm needs to sound while the context is `suspended`, the down banner shows the `Enable sound` button (click → resume → start beeping). Never throws; if WebAudio is missing, skip silently.
- **Down alarm**: two-tone beep pattern — 880 Hz then 660 Hz, 160ms each, 40ms gap, `sine` oscillator through a gain envelope (attack 10ms to 0.18, release 60ms) — repeated every **3s** while down. Stops immediately on restore, on Mute, or when `soundAlerts` is false.
- **Slow chime**: single 660 Hz → 990 Hz glide, 220ms, gain 0.12, once per new slow result.
- **Restored**: single soft 990 Hz 120ms blip (only if a down alarm was audible).
- **Mute** (top bar, `M`): session-scoped (sessionStorage try/catch), silences everything, does not change the server setting. While muted during an outage, the mute button shows `bell-off` in `danger` to remind.
- Respect `soundAlerts` setting from the server; Settings "Test sound" plays the down pattern once.

---

## 6. Loading, empty, error states

**Initial load** (before first `/api/state` or SSE snapshot): skeletons with `nm-shimmer` (`bg-surface-2` with a 30% wider gradient of `surface-3`), radius-sm:
- KPI cards: 1 label bar (60×10), 1 value bar (110×24), 1 meta bar (140×10).
- Chart: 4 faint gridlines + a flat shimmer area.
- Table: 6 skeleton rows (32px tile square, 2 text bars 160/110, then column bars).
- Events: 5 rows.
Skeletons appear only after 150ms (avoid flash on fast loads). Reduced motion: static `surface-2` blocks.

**Scanning** (devices list empty but scan in progress): table body shows a centered 32px `radar`-style spinner icon + "Scanning 192.168.1.0/24…" + "Devices appear as they answer. This takes about 10 seconds."

**Empty states**:
- No devices after scan: icon `network` in a 48px muted tile, "No devices found", "Make sure this computer is connected to your local network." 
- Filter/search no results: "No devices match “xyz”" + `Clear filters` button.
- Saved tab empty: "No saved devices yet", "Save a device to name it and get notified when it disconnects."
- Offline tab empty: "Everything is online" with `check-circle` in success.
- Events empty: see §3.11. Chart empty: see §3.9.

**Backend unreachable** (`BackendBanner.vue`, `data-testid="backend-banner"`): if the EventSource errors and does not reopen within 3s, or REST calls fail with network errors:
- Full-width bar directly under the top bar: `bg-surface-2 border-b border-border`, `nm-spin` `refresh-cw` icon, **"Backend unreachable — reconnecting…"** + muted "Attempt 3 · last update 10:41:12" + `Retry now` button.
- Reconnect with backoff 1s, 2s, 4s, 8s, max 15s (manual EventSource re-creation; reset on success).
- All live data dims to `opacity-60` with a small `Stale` badge on KPI cards; "last seen" timers keep ticking but devices are not marked offline client-side; alarm sounds stop (we no longer know the state); title prefix `… ` ("… Reconnecting · NetMon").
- Live dot in top bar: `Reconnecting…` (warning) then `Offline` (danger) after 30s.
- On reconnect: banner disappears, a success toast "Reconnected" (only if it was shown > 5s), state refetched.

---

## 7. Icons (`web/src/components/ui/Icon.vue`)

Hand-written lucide-style inline SVG, no dependency. Component props: `name` (string), `size` (number, default 16), `strokeWidth` (default 1.75), plus attrs passthrough (`class`). Renders `<svg viewBox="0 0 24 24" width height fill="none" stroke="currentColor" stroke-width stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">` with inner elements from a `name → string of SVG child markup (path/circle/rect/line/polyline)` map, injected via `v-html` (static, trusted). Unknown name → `help-circle` + console.warn in dev. Decorative by default; icon-only buttons supply `aria-label` on the button, never on the svg.

Drawing rules: 24-unit grid, 2-unit padding (live area 2–22), corner radius 2 on rects, consistent 1.75 stroke, no fills (except small dots as `r=1` circles with fill=currentColor when needed, e.g. `more-horizontal`). Match lucide shapes so they read as familiar.

**Required set**

Device categories: `monitor` (screen rect + stand), `laptop` (screen + base trapezoid), `smartphone` (tall rounded rect + bottom dot), `tablet` (wider rounded rect + dot), `watch` (round face + straps), `router` (box with antenna lines and two LED dots), `wifi` (3 arcs + dot), `network` (3 squares connected by tree lines), `tv` (wide screen + angled antenna), `cast` (screen corner + cast arcs), `speaker` (tall rect + woofer circle + tweeter dot), `printer` (paper top + body + output tray), `camera` (body + lens circle), `gamepad` (controller outline + d-pad + 2 buttons), `hard-drive` (wide rect split + 2 dots), `server` (two stacked rects + dots), `home` (house outline + door), `plug` (prongs + body), `help-circle` (circle + ? glyph).

UI: `sun`, `moon`, `monitor` (theme system), `bell`, `bell-off`, `volume-2`, `volume-x`, `settings` (gear), `search`, `x`, `check`, `check-circle`, `chevron-down`, `chevron-up`, `chevron-right`, `arrow-up-down` (sort), `arrow-down`, `arrow-up`, `more-horizontal`, `pencil`, `trash`, `bookmark`, `bookmark-plus`, `star`, `copy`, `eye`, `eye-off`, `shield` (private MAC), `globe` (internet), `building` (ISP), `map-pin`, `activity` (ping), `gauge` (speed), `play`, `refresh-cw`, `loader` (spinner), `alert-triangle`, `alert-octagon`, `info`, `wifi-off`, `circle-off`, `plus-circle`, `arrow-up-circle`, `clock`, `filter`, `sparkles` (auto-detect option), `external-link`, `logo` (NetMon mark: 3 nodes in a triangle joined by lines).

---

## 8. Motion

- Durations: `120ms` (hover/press/color), `180ms` (popover/menu/toast in), `240ms` (drawer/modal), `400ms` (number tween), `1.6s` (alarm pulse). Easing `cubic-bezier(0.2, 0.8, 0.2, 1)` for enter, `cubic-bezier(0.4, 0, 1, 1)` for exit.
- Popover/menu: opacity 0→1 + scale .98→1 from anchor side. Modal: opacity + translateY 8px→0. Mobile sheet: translateY 100%→0. Drawer: translateX 100%→0.
- KPI numbers tween from previous to new value (400ms, rAF, tabular so width is stable). Speed-test live values update without tween (they already stream).
- Live dot `nm-ping` halo only when connected. Device status dot changes color with 300ms transition; a new device row flashes (`nm-flash`).
- Table re-sorts are instant (no FLIP) to keep it calm; rows don't jump while the pointer is over the table — defer re-sort until pointer leaves or 5s pass (keeps "Save" button under the cursor).
- `@media (prefers-reduced-motion: reduce)`: disable pulse, ping halo, shimmer, flash, tweens, chart point animation; keep color changes; transitions ≤ 1ms.

---

## 9. Accessibility

- **Contrast**: all text tokens meet WCAG AA (≥ 4.5:1) on `surface`, `surface-2` and `bg` in both themes; `-fg` variants meet AA on their own `/12–/15` soft backgrounds. Status is never color-only: dots have text labels/tooltips and sr-only text; quality uses words; offline rows say "Offline"; threshold breaches say "below".
- **Focus**: `:focus-visible` ring on every interactive element — `outline: 2px solid var(--color-accent); outline-offset: 2px;` (inside table cells use `outline-offset: -2px`). Never remove outlines without replacement. Mouse clicks don't show rings.
- **Keyboard**: logical tab order (top bar → banners → KPIs' links → speed panel → devices toolbar → table → events). Shortcuts (ignored while typing in inputs; listed in a `?` help popover in Settings > About): `/` search, `M` mute, `,` settings, `R` run speed test, `T` cycle theme, `Esc` close overlay/clear search. Table rows are not focusable themselves; their controls are. Menus: ↑/↓, Home/End, Enter, Esc, type-ahead; `aria-haspopup`, `aria-expanded`.
- **Overlays**: focus trap, `aria-modal`, labelled titles, Esc to close, return focus, inert background (`inert` attribute on `#app` main when modal open).
- **Live regions**: down banner `role="alert"` (assertive, once); slow/info banners and toasts `role="status"` (polite); speed test progress announces phase changes only; SSE connection changes announced politely ("Live updates reconnected"). Never announce every ping/sample.
- **Semantics**: devices list is a real `<table>` with `<caption class="sr-only">Devices on 192.168.1.0/24</caption>`, `<th scope="col">`, `aria-sort`; mobile cards are a `<ul role="list">`. KPI cards are `<section aria-labelledby>`. Charts have `role="img"` + hidden data table.
- **Targets**: ≥ 32×32 on desktop, ≥ 40×40 on touch (`@media (pointer: coarse)` enlarges IconButtons).
- **Zoom/reflow**: works at 200% zoom and 320 CSS px reflow without loss (cards stack).
- **Tooltips**: shown on hover after 300ms and on keyboard focus immediately; `role="tooltip"` with `aria-describedby`; never hold essential-only info on touch — essential info (e.g. "Requires router integration") is also available via the cell's `aria-label`/sr-only text, and tooltips open on tap for touch.

---

## 10. Test hooks (`data-testid`) — contract for Playwright

Top bar: `sse-status`, `theme-toggle`, `mute-toggle`, `settings-btn`, `mock-badge`.
Banners/toasts: `backend-banner`, `banner-internet-down`, `banner-slow`, `banner-slow-dismiss`, `banner-devices-offline`, `toast` (with `data-kind="success|info|warning|danger"`), `enable-sound-btn`.
KPIs: `kpi-internet-status` (with `data-state="up|down|unknown"`), `kpi-download`, `kpi-upload`, `kpi-ping`, `kpi-isp`; numeric value elements inside each: `kpi-value`.
Speed: `run-speedtest`, `speedtest-progress`, `speed-chart`, `speed-range-<6h|24h|7d|all>`, `threshold-line`.
Devices: `devices-table` (desktop) / `devices-list` (mobile), `device-row` (`data-mac`, `data-online`, `data-saved`, `data-category`), `device-name`, `device-type-label`, `device-type-icon`, `confidence-dot`, `device-why`, `evidence-popover`, `evidence-item`, `private-mac-badge`, `self-badge`, `gateway-badge`, `throughput-na`, `quality-badge`, `last-seen`, `save-device-btn`, `device-menu-btn`, `menu-forget`, `menu-edit`, `filter-tab-<all|online|offline|saved|new>`, `type-chip-<computers|mobile|network|media|iot|unknown>`, `type-filter`, `search-input`, `composition-strip`.
Modals: `save-modal`, `save-name-input`, `save-type-select`, `save-notes-input`, `save-submit`, `save-cancel`, `forget-btn`, `confirm-dialog`, `confirm-forget`.
Settings: `settings-drawer`, `setting-threshold`, `setting-interval`, `setting-sound`, `setting-notifications`, `setting-fingerprinting`, `setting-theme`.
Events: `events-panel`, `event-item` (`data-kind`).

Copy strings that tests may assert (keep exact): "Internet is down since", "retrying every 5s", "Internet speed below 200 Mbps" (number from threshold), "Internet restored", "New device joined", "Requires router integration", "Private", "This device", "Gateway", "Router (gateway)", "Offline · ", "Backend unreachable — reconnecting…", "Run speed test", "Auto-detect".
