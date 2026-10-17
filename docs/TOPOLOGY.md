# NetMon — Topology Map + Device Detail Panel (spec)

Status: authoritative spec for the "Map" view of the Devices section. Four coders work **in parallel on new
files only** (see §1). Nobody edits an existing file in this phase; a later integrator applies §10.
Where this doc is silent, PLAN.md (data/API) and DESIGN.md + the existing code (look) win. The existing
code wins over DESIGN.md where they differ (e.g. quality thresholds come from `components/devices/deviceUi.js`).

User request: *"The devices section — I want a topology / map in a canvas; when I click a device I can see
the details of that device."*

Conventions recap (PLAN.md): MAC in JSON = lowercase colon form `a4:83:e7:1c:2d:01`; in testids/URLs = dashes
`a4-83-e7-1c-2d-01`; `null` never `undefined` on the wire; no emojis; ESM, plain JS, Vue 3.5 `<script setup>`,
Tailwind v4 token utilities (`bg-surface`, `text-muted`, `border-border`, `bg-cat-network/12`, …).

---

## 1. Files and owners

| Owner | New files (create exactly these) |
|---|---|
| **layout** | `web/src/components/topology/layout.js` |
| **canvas** | `web/src/components/topology/TopologyMap.vue`, `nodes/InternetNode.vue`, `nodes/GatewayNode.vue`, `nodes/HubNode.vue`, `nodes/DeviceNode.vue`, `edges/LinkEdge.vue`, `MapToolbar.vue`, `MapLegend.vue` (all under `web/src/components/topology/`) |
| **detail** | `web/src/components/detail/DeviceDetailPanel.vue`, `DetailFacts.vue`, `DetailLatencyChart.vue`, `DetailEvidence.vue`, `DetailEvents.vue`, `ConnectedViaSelect.vue` (all under `web/src/components/detail/`) |
| **server** | `server/src/core/topology.js` |

Rules: do not edit or create any other file (no stubs of another owner's file). canvas and detail import
`layout.js` by its exact path and the exports in §3.1 — if it does not exist yet while you work, code against
this contract. Existing modules you may **import** (read-only): `store.js` (only the actions that exist today:
`saveDevice`, `forgetDevice`, `refingerprint`, `pushToast`, `state`, `ui`), `lib/deviceTypes.js`, `lib/format.js`,
`components/ui/*`, `components/devices/deviceUi.js`, `components/devices/devicesState.js`,
`components/devices/DeviceEditModal.vue`, `ForgetDeviceDialog.vue`, `QualityBadge.vue`, `composables/useNow.js`.
New store actions (`setDeviceParent`, …) do **not** exist yet → components **emit** instead of calling them (§4, §6).

Vue Flow is installed in `web/` (`@vue-flow/core@1.48.2`, `@vue-flow/background@1.3.2`, `@vue-flow/minimap@1.5.4`,
`@vue-flow/controls@1.1.3`). We do **not** use `<Controls>` (MapToolbar replaces it), so only these CSS imports,
at the top of `TopologyMap.vue`'s `<script setup>`:
```js
import '@vue-flow/core/dist/style.css';
import '@vue-flow/core/dist/theme-default.css';
import '@vue-flow/minimap/dist/style.css';
```

---

## 2. Concept and topology model

```
                         ┌──────────────────────────────────┐
                         │ (globe) Comcast Cable Comm…      │   InternetNode
                         │ 73.•••.•••.14 · AS7922           │
                         │ ● Online · 14 ms   ↓452 ↑40 Mbps │
                         └───────────────┬──────────────────┘
                                         ║  WAN edge (thick, flow dots)
            [▭] Jon's MacBook ── you     ║                    [▭] HP LaserJet
                       \            ┌────╨────┐              /
     [▭] DESKTOP-7Q2K9LM ─────────  │ (router)│ ────────────  [?] 00:25:96:12:34:0a
                                    │  unifi  │
                                    │ Gateway │ ───────────── [spk] Sonos-Living-Room
                                    └────┬────┘
                                         │ uplink
                                     (wifi) Deco-M5        HubNode (access point / mesh / secondary router)
                                   /      |      \
                        [ph] Jons-iPhone [ph] Pixel-8 [tv] LGwebOSTV        DeviceNodes (user-set "Connected via")
```

- **Internet** node (one, always present) → **Gateway** node (the device with `isGateway`; a placeholder
  node when no gateway device is known) → **hubs** and **devices**.
- **Hub** = any device with `category ∈ HUB_CATEGORIES = ['access_point','router','network_switch']` and
  `!isGateway`. Hubs attach to the gateway by default, or to another hub (user-set, no cycles).
- **Devices** (everything else) attach to the gateway by default. NetMon cannot know which AP a client is
  associated with (no router integration), so the user can **re-parent** a device: drag it onto a hub/gateway
  node in the map, or pick "Connected via" in the detail panel. Persisted per MAC on the server (§7):
  `parentMac` (`null` = gateway) and a pinned `position` (set when the user drags a node and drops it on empty canvas).
- Ping latency is measured from this computer to each device end-to-end, so an edge's quality is the quality
  of the **child** device (`connectionQuality(child)`), whatever the parent is.
- Mock defaults (§7.4): iPhone, Pixel 8 and the LG TV are "Connected via" the Deco M5, so the mock map
  demonstrates a hub out of the box.

---

## 3. Layout engine — `web/src/components/topology/layout.js` (owner: layout)

Pure ES module: **no Vue imports, no DOM, no `Math.random`, no `Date.now`**. Deterministic: the same inputs
always produce identical output (same order, same coordinates). Allowed imports:
`../../lib/deviceTypes.js` (`CATEGORIES`, `CATEGORY_TINTS`, `deviceDisplayName`, `deviceTypeLabel`, `deviceIcon`)
and `../devices/deviceUi.js` (`connectionQuality`, `ipToNumber`, `macDashes`).

### 3.1 Exports (exact)

```js
export const NODE_TYPES = { internet: 'internet', gateway: 'gateway', hub: 'hub', device: 'device' };
export const EDGE_TYPE = 'link';
export const HUB_CATEGORIES = ['access_point', 'router', 'network_switch'];
export const MAX_NODES = 200;                 // device+hub nodes rendered; rest reported in meta.truncated
export const INTERNET_ID = 'internet';
export const PLACEHOLDER_GATEWAY_ID = 'gateway';

// Box size of each node type in flow px (components render exactly this size) and the edge anchor
// (= icon-tile centre) relative to the node's top-left corner.
export const NODE_SIZES = {
  internet: { w: 240, h: 96,  anchor: { x: 120, y: 48 } },
  gateway:  { w: 200, h: 128, anchor: { x: 100, y: 32 } },
  hub:      { w: 136, h: 104, anchor: { x: 68,  y: 26 } },
  device:   { w: 112, h: 88,  anchor: { x: 56,  y: 22 } },
};

// Tint groups used for sectors (keys of TINT_CLASSES in lib/deviceTypes.js), in sector order.
export const GROUP_ORDER = ['computer', 'mobile', 'media', 'iot', 'network', 'unknown'];
export const GROUP_LABELS = { computer: 'Computers', mobile: 'Phones & tablets', media: 'Media',
  iot: 'IoT & printers', network: 'Network', unknown: 'Unknown' };

export function isHub(device)                       // HUB_CATEGORIES.includes(device?.category) && !device.isGateway
export function findGateway(devices)                // first device with isGateway in input order, else null
export function nodeIdForMac(mac)                   // === mac (colon form). Node ids ARE MACs, except the two ids above.
export function testidForMac(mac)                   // 'map-node-' + macDashes(mac)

/**
 * Effective parent of every non-gateway device.
 * @returns Map<mac, { parentMac: string|null /* null = gateway */, source: 'user'|'default'|'fallback' }>
 *  'user'     override.parentMac points at a present hub (or is null explicitly) and creates no cycle
 *  'default'  no override → gateway
 *  'fallback' override.parentMac points at a MAC that is missing / not a hub / would cycle → gateway
 */
export function resolveParents(devices, overrides)

/** True if setting `mac`'s parent to `parentMac` would create a cycle (walks override parents). */
export function wouldCreateCycle(mac, parentMac, overrides)

/**
 * Options for the "Connected via" select of `device`:
 * [{ value: null, label: 'Gateway', sublabel: '<gateway display name>', isDefault: true },
 *  { value: '<hub mac>', label: '<hub display name>', sublabel: deviceTypeLabel(hub), online }]...
 * Excludes the device itself, its descendants (cycle) and — when device is the gateway — returns [].
 * Hubs ordered by display name (Intl.Collator, numeric), then mac.
 */
export function hubOptions(device, devices, overrides)

/** WAN edge quality from InternetStatus: 'down' | 'unknown' | 'good' (<50 ms) | 'fair' (<150) | 'poor'. */
export function wanQuality(internet)

/**
 * Structural key: changes iff node set, parents, groups, hub-ness, pinned positions or groupBy change.
 * Online/offline flips, latency, names and highlight do NOT change it.
 */
export function layoutKey(devices, { overrides = {}, groupBy = 'type' } = {})

/** Pick the drop target for a dragged node: the hub/gateway node whose box contains the dragged
 *  node's anchor point; ties → smallest centre distance, then id. Returns node id or null.
 *  `dragged` / `candidates` are { id, type, position:{x,y} } (sizes from NODE_SIZES). Never returns
 *  the dragged node itself or one of its descendants (pass `excludeIds`). */
export function pickDropTarget(dragged, candidates, { excludeIds = [] } = {})

/** Main entry. */
export function buildGraph(devices, {
  isp = null,            // Isp | null (PLAN §2.7)
  internet = null,       // InternetStatus | null
  speed = null,          // speed state (PLAN §4.3) | null
  network = null,        // state.network | null (placeholder gateway ip, cidr)
  overrides = {},        // { [mac]: { parentMac: string|null, position: {x,y}|null } }
  highlight = null,      // Set<mac> | null — the brief's `filter`: null = no filter active
  groupBy = 'type',      // 'type' | 'flat'
  reducedMotion = false,
  maxAnimatedEdges = 60,
} = {}) // => { nodes, edges, meta }
```

### 3.2 Output shapes (Vue Flow format)

Node (every node):
```js
{ id, type /* NODE_TYPES */, position: { x, y } /* top-left, integers */, data,
  draggable /* false for internet + gateway (anchors), true otherwise */,
  selectable: false, connectable: false, focusable: false, zIndex: 0 /* hubs 1, gateway 2 */ }
```
`node.data` common fields: `{ kind, testid, anchor, dimmed, highlighted }` where `dimmed = highlight !== null &&
!highlight.has(mac)` (internet and gateway never dimmed), `highlighted = highlight !== null && highlight.has(mac)`.

| type | `data` (in addition to the common fields) |
|---|---|
| `internet` | `{ status: 'up'|'down'|'unknown', latencyMs, since, isp: { name, asn, ip, ipMasked /* maskIp() */, city, country, colo } | null, speed: { running, phase, percent, currentMbps, downloadMbps, uploadMbps, lastAt } }` — `testid: 'map-node-internet'` |
| `gateway` | `{ mac /* or null */, device /* Device or null */, placeholder: boolean, name, typeLabel, ip /* device.ip ?? network.gateway */, online, quality, counts: { online, offline, total } /* all devices */, clientCount /* direct children */ }` — `testid: 'map-node-gateway'` |
| `hub` | `{ mac, device, name, typeLabel, ip, category, icon, online, quality, latencyMs, clientCount, parentMac, parentSource, pinned, saved }` — `testid: testidForMac(mac)` |
| `device` | `{ mac, device, name, typeLabel, ip, category, group /* tint group */, icon, online, quality, latencyMs, isSelf, saved, parentMac /* effective, null = gateway */, parentSource, pinned }` — `testid: testidForMac(mac)` |

`name = deviceDisplayName(d)`, `typeLabel = deviceTypeLabel(d)`, `icon = deviceIcon(d)`, `quality =
connectionQuality(d)` (`'good'|'fair'|'poor'|'offline'|'none'`); for `isSelf` the quality is `'self'` (self is
not pinged but is online). Placeholder gateway: `name 'Gateway'`, `typeLabel 'Router (not detected)'`.

Edge:
```js
{ id: 'e-internet' | 'e-' + mac, type: 'link', source /* parent node id */, target /* child node id */,
  sourceHandle: 'out', targetHandle: 'in', data }
```
`edge.data`:
```js
{ kind: 'wan' | 'uplink' /* parent→hub */ | 'lan' /* parent→device */,
  mac /* child mac, null for wan */, testid: 'map-edge-internet' | 'map-edge-' + macDashes(mac),
  quality: 'good'|'fair'|'poor'|'offline'|'none'|'self'|'down'|'unknown',
  online, latencyMs, jitterMs, lossPct,
  label /* hover text: '8.4 ms · 0% loss', '14 ms' (wan), 'This computer' (self), 'Offline' */,
  assumed /* parentSource !== 'user' */, dimmed /* target dimmed */, animated /* §5.6 rule */ }
```
`animated` = `!reducedMotion && online && quality ∉ {offline, none, down, unknown} && !dimmed`, then only the
first `maxAnimatedEdges` such edges in output order keep `true` (WAN first, then uplinks, then lan).

Output order (also DOM/Tab order): internet, gateway, hubs (by angle), devices (sector by sector, ring by ring,
angle ascending). Edges: WAN, uplinks, lan in node order. `meta = { layoutKey, center: {x:0,y:0}, bounds:
{ minX, minY, maxX, maxY }, gatewayId, hubIds: string[], counts: { devices, hubs, online, offline, pinned },
truncated /* number of devices not rendered */ }`.

### 3.3 Algorithm (radial, tiered)

Coordinates are flow px, screen orientation (x right, y down). Angles in radians, 0 = +x, π/2 = down.
Gateway **centre** = (0,0). All placement computes centres; `position = centre − (w/2, h/2)`, rounded.

1. **Inputs.** Skip devices without a valid `mac`. Gateway = `findGateway(devices)` (else placeholder, id
   `'gateway'`, no mac). If more than `MAX_NODES` non-gateway devices: keep hubs first, then the first
   `MAX_NODES − hubs` others in input order (callers pass `devicesSorted`); `meta.truncated = dropped count`.
2. **Parents.** `resolveParents()`. Children of the gateway = hubs with parent null + devices with parent null.
3. **Internet** centre = (0, −230).
4. **Sweep.** The wedge around straight up (−π/2 ± 32°) is reserved for the WAN edge. Usable sweep starts at
   `−π/2 + 32°` (= −58°), length `S = 2π − 64°` (296°), clockwise.
5. **Sectors around the gateway** (`groupBy`):
   - one **hub sector** per gateway-child hub, ordered by hub IP (`ipToNumber`, then mac);
   - **group sectors** for gateway-direct devices: `groupBy 'type'` → one per non-empty `GROUP_ORDER` group
     (`CATEGORY_TINTS[category] ?? 'unknown'`); `groupBy 'flat'` → a single sector with all of them.
   - Sector order = round-robin interleave `g0, h0, g1, h1, …` then the leftovers (spreads hubs around the ring).
   - Items of a sector: group sector → its devices; hub sector → the hub's children (sub-hubs first, then
     devices) **and** recursively their children (flattened, each still edged to its real parent).
   - Item sort within a sector: sub-hubs first; `isSelf` first; `CATEGORIES.indexOf(category)`; IP numeric
     (`ipToNumber`, null last); mac.
6. **Radii.** `H` = number of hub sectors. `R_HUB = max(280, ceil(H × 168 / S))`.
   `R0 = H > 0 ? R_HUB + 190 : 250` (first client ring). `RING = 112`. `ARC = 128` (min arc distance between
   client centres). `PAD = 0.06` rad between sectors.
7. **Angles.** Weight `w = max(1, items)` (+1 for hub sectors). Minimum angle: hub sector `168 / R_HUB`, group
   sector `min(items, 3) × ARC / R0`. Raw `θ_i = (S − PAD × n) × w_i / Σw`; raise to the minimum; if the total
   exceeds `S − PAD × n`, scale every sector above its minimum down proportionally (never below its minimum;
   if minimums alone exceed the sweep, scale all equally). Sectors are laid out consecutively from the sweep start.
8. **Hubs** sit at their sector mid-angle on `R_HUB`.
9. **Rings.** Fill a sector's items into rings `k = 0,1,…` with radius `R_k = R0 + k × RING` and capacity
   `c_k = max(1, floor(θ × R_k / ARC))`; the `n_k` items on a ring are centred: angle = `start + θ × (j + 0.5) / n_k`.
   Odd rings are offset by `+0.5 × ARC / R_k` (clamped inside the sector) so rows stagger.
10. **Pinned.** A node whose override has a valid `position` (finite, |v| ≤ 10000) uses it verbatim
    (`data.pinned = true`); it is fixed during step 11. Internet and gateway are never pinned.
11. **Collision pass.** AABB of every node box inflated by 12 px. Up to 50 passes over pairs in output order:
    if two boxes overlap, push movable nodes apart along the centre-to-centre vector by the overlap depth
    (split 50/50 if both movable; all to the movable one otherwise; coincident centres → push along angle
    `index × 2.399963` rad). Fixed: internet, gateway, pinned nodes. Stop early when a pass moves nothing.
    Complexity O(n²·passes) ≈ 2 M checks at 200 nodes (< 15 ms) — acceptable; no spatial index needed.
12. Round to integers, compute `bounds`, emit nodes/edges.

Edge cases that must work: 0 devices (internet + placeholder gateway + WAN edge), only self, all offline,
gateway missing, 200+ devices, a hub whose override parent is itself / a descendant / gone (→ fallback),
override for a MAC not in `devices` (ignored), `groupBy` unknown (→ `'type'`), `highlight` an empty Set (all dimmed).

Reference result for the mock (10 devices + mock default overrides, `groupBy 'type'`): sectors in order
`computer[self, Windows PC] · hub Deco M5[iPhone, Pixel 8, LG TV] · media[Sonos] · iot[HP printer] · unknown[00:25:96:12:34:0a]`.

---

## 4. Canvas — `web/src/components/topology/*` (owner: canvas)

### 4.1 `TopologyMap.vue` contract

```js
props: {
  devices:    { type: Array,  default: () => [] },   // pass devicesSorted (PLAN §5 order)
  isp:        { type: Object, default: null },
  internet:   { type: Object, default: null },
  speed:      { type: Object, default: null },
  network:    { type: Object, default: null },        // optional extra: placeholder gateway IP, cidr, scanning
  overrides:  { type: Object, default: () => ({}) },
  selectedMac:{ type: String, default: null },
  highlight:  { type: Object, default: null },        // Set<mac> | null
  loaded:     { type: Boolean, default: true },       // false → skeleton
  readonly:   { type: Boolean, default: false },      // true → no dragging (forced on coarse pointer < 768 px)
}
emits: ['select' /* (mac|null) */, 'move' /* (mac, {x,y}) */, 'reparent' /* (mac, parentMac|null) */, 'resetLayout' /* () */]
defineExpose({ fitView(), focusNode(mac), centerOn(mac) })
```
Root: `<div class="nm-topology relative h-full w-full overflow-hidden bg-bg" data-testid="topology-map"
data-node-count data-group-by>`; the parent decides the height (§8.2).

Vue Flow setup (exact props): `id="netmon-topology"`, `:nodes`, `:edges` (shallowRefs derived from
`buildGraph`), `:node-types` mapping `{ internet: markRaw(InternetNode), gateway: markRaw(GatewayNode),
hub: markRaw(HubNode), device: markRaw(DeviceNode) }`, `:edge-types="{ link: markRaw(LinkEdge) }"`,
`:min-zoom="0.2" :max-zoom="2" :nodes-connectable="false" :elements-selectable="false"
:nodes-focusable="false" :edges-focusable="false" :delete-key-code="null" :selection-key-code="null"
:multi-selection-key-code="null" :zoom-on-scroll="false" :zoom-on-pinch="true" :pan-on-scroll="false"
:prevent-scrolling="false" :zoom-on-double-click="false" :node-drag-threshold="4"
:nodes-draggable="!readonly && !coarseSmall" :only-render-visible-elements="nodes.length > 120"
:auto-pan-on-node-drag="true"`. Page wheel scroll must keep scrolling the page; trackpad pinch / Ctrl+wheel
zoom (Vue Flow's zoomOnPinch). On a plain wheel over the canvas show a 1.5 s hint pill
"Use Ctrl + scroll to zoom" (⌘ on macOS) bottom-centre (`data-testid="map-zoom-hint"`).

Behaviour:
- **Graph**: `graph = computed(() => buildGraph(devices, { …props, groupBy, reducedMotion }))`. Feed new arrays
  to Vue Flow only when not dragging; while a drag is in progress keep the current arrays and apply the latest
  graph on drag stop. Vue Flow reuses internal nodes by id, so data-only updates do not move anything.
- **Transient UI state** (hover, selection, drop target, zoom) is *not* in `buildGraph`; TopologyMap provides
  `provide('nm-topology-ctx', ctx)` with `ctx = reactive({ selectedId, hoveredId, dropTargetId, draggingId,
  zoom, reducedMotion })`; node/edge components `inject('nm-topology-ctx')` (default to an inert object).
  `selectedId` mirrors `selectedMac` (gateway's mac selects the gateway node).
- **Click / keyboard select**: node click or Enter/Space on a focused node → `emit('select', mac)` (gateway →
  its mac; placeholder gateway and internet → no emit). Pane click → `emit('select', null)`. `Esc` inside the
  map → `emit('select', null)`.
- **Drag**: `onNodeDrag` → `ctx.dropTargetId = pickDropTarget(node, hub/gateway nodes, { excludeIds: self +
  descendants })`. `onNodeDragStop`: if a drop target exists and differs from the current parent → `emit
  ('reparent', mac, targetId === gatewayId ? null : targetId)` (do **not** emit move; the node snaps into its new
  parent's sector — the store clears the pinned position); else `emit('move', mac, { x, y })` with the node's
  rounded `position`. Internet and gateway are not draggable.
- **Viewport**: on first `onNodesInitialized` → `fitView({ padding: 0.15, maxZoom: 1.1, duration: 0 })`. Later
  structure changes do not refit (user keeps their viewport). `centerOn(mac)` = `setCenter(x, y, { zoom:
  current, duration: reducedMotion ? 0 : 300 })` shifted right by `panelWidth / 2 / zoom` when the detail panel
  (side mode, 380 px) is open; called by the parent when a node is selected and its anchor is under the panel
  or out of view. `focusNode(mac)` focuses `[data-testid=<node testid>] [data-node-focus]`.
- **Prefs**: `groupBy` ('type'|'flat'), `legendOpen` (bool, default false), `minimapOpen` (default true ≥ md)
  persisted in `localStorage['netmon.map.prefs']` (try/catch, JSON).
- **Reduced motion**: `matchMedia('(prefers-reduced-motion: reduce)')` (+ change listener) → `ctx.reducedMotion`,
  passed to `buildGraph` (disables flow dots — SMIL is not covered by the global CSS rule) and duration 0 for
  fit/center animations.
- **Overlays inside the canvas** via Vue Flow `<Panel>`: MapToolbar `top-left`; MapLegend `bottom-left` (when
  open); MiniMap `bottom-right` (hidden < 768 px, `pannable zoomable`, 168×112, `data-testid="map-minimap"`,
  `:node-class-name="n => 'nm-mm nm-mm-' + (n.data.group || n.type)"`); truncation note top-right
  `"Showing 200 of 240 devices — use List for all"` (`map-truncated-note`).
- **Background**: `<Background variant="dots" :gap="24" :size="1" />`, colour set via CSS (below).
- **Empty / loading** (`data-testid="map-empty"` overlay centred, pointer-events only on its buttons):
  `!loaded` → skeleton: 3 faint shimmering circles (`nm-skeleton rounded-full`) in a triangle;
  `devices.length === 0 && (network?.scanning || !network?.firstScanDone)` → the graph (internet + placeholder
  gateway) plus pill "Scanning 192.168.1.0/24…" with spinning `radar` icon; `!network` → EmptyState `wifi-off`
  "No network connection"; `highlight` is an empty Set → small top-centre pill "No devices match these filters"
  + `Clear filters` link emitting nothing (parent shows its own clear; pill only informs).
- **Global CSS** (non-scoped `<style>` in TopologyMap, every selector prefixed `.nm-topology`):
  `.vue-flow__node{padding:0;border:0;background:transparent;box-shadow:none;border-radius:0}`
  `.vue-flow__background pattern circle{fill:var(--color-border-strong)}`, `.vue-flow__pane{cursor:grab}`
  `.vue-flow__pane.dragging{cursor:grabbing}`, `.vue-flow__minimap{background:var(--color-surface);
  border:1px solid var(--color-border);border-radius:var(--radius-md);box-shadow:var(--shadow-popover)}`
  `.vue-flow__minimap-mask{fill:color-mix(in oklab,var(--color-bg) 72%,transparent)}`,
  `.nm-mm-computer{fill:var(--color-cat-computer)}` … one per tint group, `.nm-mm-internet,.nm-mm-gateway
  {fill:var(--color-cat-network)}`, `.vue-flow__handle{opacity:0;pointer-events:none;width:1px;height:1px;
  min-width:0;min-height:0;border:0}`, `.vue-flow__edge-path` not used (LinkEdge draws its own paths).
  Never rely on CSS `var()` inside SVG presentation attributes — use `style` or CSS.

### 4.2 Node visual design (shared rules)

Every node component: `props` = Vue Flow `NodeProps` (`id`, `data`, `dragging`, …). Root element is a
fixed-size box (`NODE_SIZES[type].w × h`, `style` width/height) with `data-testid=data.testid`, `data-kind`,
`data-category`, `data-online`, `data-selected`, `data-dimmed`, `data-highlighted`, `data-pinned`,
`data-parent` (`parentMac ?? 'gateway'`), `data-quality`, `data-mac` (gateway/hubs/devices). Inside: one
focusable element `<div role="button" tabindex="0" data-node-focus :aria-label :aria-pressed="selected">` that
wraps the tile (Enter/Space → `ctx`-provided `select(id)` function; TopologyMap puts `select` on ctx).
Two hidden handles at the anchor: `<Handle id="in" type="target" :position="Position.Top"
:style="{ left: anchor.x+'px', top: anchor.y+'px' }" />` and `<Handle id="out" type="source"
:position="Position.Bottom" :style="…same" />` (internet: `out` only; device: `in` only; gateway/hub both).
`aria-label` = `"<name>, <typeLabel>, Online|Offline, <latency> ms, connected via <parent name>"`.

Labels: centred under the tile, `max-width` = node width, single line `truncate`; text halo for
legibility over edges: `text-shadow: 0 0 2px var(--color-bg), 0 0 4px var(--color-bg)`. Level of detail via
`ctx.zoom`: `< 0.55` hide secondary line; `< 0.35` hide names (tile only).

Tile anatomy: opaque `bg-surface` square with an inner tint layer (`categoryTint(category).tile`, i.e.
`bg-cat-x/12 text-cat-x`), 1 px `border-border`, icon in the tint colour. Offline: tint removed
(`OFFLINE_TILE` from deviceUi = `bg-surface-3 text-subtle`), dashed `border-border-strong`, whole node
`opacity-60`. **Status dot** (bottom-right of the tile, 10 px, 2 px `ring-surface` ring): `QUALITY[quality].dot`
from deviceUi (good success / fair warning / poor danger / offline hollow `border border-subtle` / none
`bg-border-strong`); self → `bg-accent`.

States (combine; transitions 120 ms colour/transform, 300 ms status dot colour):
| state | treatment |
|---|---|
| hover (`ctx.hoveredId`) | tile `border-border-strong`, `-translate-y-px`, `shadow-popover`; connected edge highlighted |
| selected | tile `ring-2 ring-accent` + outer `0 0 0 6px color-mix(accent 18%)` glow; name `font-semibold text-text`; label gets `bg-surface/90 rounded-sm px-1` |
| highlighted (filter match) | `ring-1 ring-accent/50` on tile, full opacity |
| dimmed (filter non-match) | `opacity-25 saturate-0`; stays focusable and clickable (no `aria-disabled`) |
| dragging | `shadow-modal`, `scale-[1.04]`, `cursor-grabbing` |
| drop target (`ctx.dropTargetId === id`) | tile `outline-2 outline-dashed outline-accent outline-offset-4` + `bg-accent/8`; caption under node "Drop to connect via <name>" (`data-testid="map-drop-hint"`, 11 px accent-fg) |
| pinned | 10 px `pin` icon at tile top-left (`text-subtle`), visible on hover/selected only |
| self | tile `ring-2 ring-accent/70`; mini pill "You" (`bg-accent text-accent-contrast`, 10 px/600, h-4 px-1, rounded-full) overlapping the tile's top-right corner |
| saved | 10 px `star-filled` `text-warning` at the end of the name line |

**DeviceNode** 112×88: tile 44×44 `rounded-xl` at top centre, icon 22 px; name 12/16 500 (y 50–66);
secondary 11/14 `text-muted tabular-nums` = IP (or `typeLabel` when IP null) (y 66–80).

**HubNode** 136×104: tile 52×52 `rounded-2xl`, icon 26 px (`wifi`/`router`/`switch` via `deviceIcon`), tile
border `border-cat-network/40`; name 13/18 600; secondary 11 px muted `typeLabel` (truncate); pill
`"<n> devices"` (`bg-surface-2 text-muted text-[10px] h-4 px-1.5 rounded-full`, `data-testid="map-hub-count"`).

**GatewayNode** 200×128: tile 64×64 `rounded-2xl` with `ring-2 ring-cat-network/35` and soft glow
`0 0 24px color-mix(in oklab, var(--color-cat-network) 22%, transparent)`, icon `router` 30 px; name 13/18 600;
secondary 11 px muted `"<typeLabel> · <ip>"`; stats pill `"10 online · 2 offline"` (offline part only when >0).
Badge `Gateway` (existing style: `bg-cat-network/12 text-cat-network ring-cat-network/25`) above the tile's
top-right. Placeholder: dashed tile border, `text-subtle` icon, name "Gateway", secondary
`network.gateway ?? 'Not detected'`; not focusable as a button (no detail).

**InternetNode** 240×96 card: `rounded-xl border border-border bg-surface shadow-card px-3 py-2.5`, row
layout: left 40 px round tile with `globe` 20 px — up `bg-success/12 text-success-fg`, down `bg-danger/15
text-danger-fg` + whole card `border-danger/50 nm-pulse-danger`, unknown `bg-surface-3 text-subtle` with
`loader` spinning. Right column: line 1 ISP name 13/600 truncate (`'Internet'` when isp null, title = full
name); line 2 11 px mono muted `ipMasked · AS7922` (`—` when unknown); line 3 status pill (`Online · 14 ms` /
`Down · 3 min` / `Checking…`, tones success/danger/neutral like Badge) and speeds `↓ 452 ↑ 40 Mbps`
(`formatMbpsValue`; arrows `text-accent-fg` / `text-info-fg`); while `speed.running`: `Testing ↓ 412 Mbps`
(phase download) / `Testing ↑ 38 Mbps` (upload) / `Measuring latency…` with a 12 px Spinner. Title tooltip
(native `title`): ISP name, ASN, city/country, colo, public IP (full), probe target. Not selectable, not
draggable. `data-status` attribute on root = internet status.

### 4.3 `edges/LinkEdge.vue`

Props: Vue Flow `EdgeProps` (`id, sourceX, sourceY, targetX, targetY, data, …`). Handles sit at the tile
anchors, so the path is the straight segment `M sourceX sourceY L targetX targetY` (nodes are drawn above
edges and tiles are opaque). Render:
```
<g :data-testid="data.testid" :data-kind :data-quality :data-online :data-animated :data-source :data-target>
  <path class="interaction" stroke="transparent" stroke-width="16" fill="none" />   ← hover target
  <path class="line" … />
  <circle v-if="data.animated" r=…><animateMotion :dur repeatCount="indefinite" :path="d" /></circle>  (1 dot; WAN 2 dots, 2nd begin = −dur/2)
</g>
<EdgeLabelRenderer> hover/selected label </EdgeLabelRenderer>
```
Stroke colours via `style` (CSS vars):

| quality | colour | opacity | dash |
|---|---|---|---|
| good | `--color-success` | .55 | — |
| fair | `--color-warning` | .8 | — |
| poor | `--color-danger` | .9 | — |
| self | `--color-accent` | .7 | — |
| none / unknown | `--color-border-strong` | 1 | `2 4` (unknown only) |
| offline | `--color-subtle` | .5 | `4 4` |
| down (wan) | `--color-danger` | .9 | `6 4` |

Widths: wan 2.5, uplink 2, lan 1.5. Hover (interaction path) or edge touching `ctx.selectedId` / `ctx.hoveredId`:
opacity 1, width +1, label visible. `data.dimmed` → opacity .12 and never animated. `data.assumed` has no
visual difference (legend explains). Flow dots: `r` 2 (wan 2.5), fill = line colour, direction parent → child,
`dur` 2.4 s (wan 1.6 s), never rendered when `ctx.reducedMotion`. Label (EdgeLabelRenderer, absolutely
positioned at the midpoint, `pointer-events:none`): `bg-overlay border border-border shadow-popover rounded-md
px-1.5 h-5 text-[11px] font-medium tabular-nums text-text`, text `data.label`, `data-testid="map-edge-label"`.

### 4.4 `MapToolbar.vue`

Props `{ zoom: Number, groupBy: String, legendOpen: Boolean, pinnedCount: Number, nodeCount: Number }`;
emits `fit`, `zoom-in`, `zoom-out`, `relayout`, `update:groupBy`, `toggle-legend`. Horizontal pill bar
`rounded-lg border border-border bg-surface/90 backdrop-blur shadow-popover p-1 gap-0.5`, 28 px IconButtons
(`ui/IconButton.vue`, size `sm`) with tooltips:
- `map-zoom-out-btn` (`minus`, "Zoom out"), zoom readout `"85%"` (11 px tabular, `aria-live="off"`),
  `map-zoom-in-btn` (`plus`, "Zoom in"), `map-fit-btn` ("Fit to screen", **inline SVG** four corner
  brackets — `Icon.vue` has no such glyph and icons.js must not be edited), divider,
- `map-relayout-btn` (`rotate-ccw`, label "Reset layout", tooltip "Reset node positions — keeps 'Connected
  via'"); disabled when `pinnedCount === 0`; shows a small count badge when >0,
- group-by `ui/Segmented.vue` size `sm`: `[{value:'type',label:'By type',testid:'map-groupby-type'},
  {value:'flat',label:'Flat',testid:'map-groupby-flat'}]`, hidden < 480 px,
- `map-legend-btn` (`info`, "Legend", `active` when open, `aria-expanded`).
Keyboard shortcuts while focus is inside the map (not in inputs): `F` fit, `+`/`=` zoom in, `-` zoom out.

### 4.5 `MapLegend.vue`

Props `{ }` (static) emits `close`. Card 248 px (`rounded-lg border bg-overlay shadow-popover p-3 text-xs`,
`data-testid="map-legend"`): title "Legend" + X; rows with mini SVG swatches: Good / Fair / Poor connection
(lines in success/warning/danger), Offline (dashed subtle), Moving dots = device is online, Accent ring = this
computer, `pin` = position pinned by you; group dots (6 tint groups with `GROUP_LABELS`); footnote (muted):
"Lines show the path from the internet to each device. NetMon can't see which access point a device uses —
drag a device onto an access point, or set 'Connected via' in its details."

### 4.6 Mobile and touch

Map height `h-[62svh] min-h-[420px]` (< 768 px) so the page can still be scrolled outside it; one-finger drag
pans, pinch zooms (Vue Flow default touch handling). On coarse pointers below 768 px node dragging is off
(`coarseSmall`), re-parenting goes through the detail panel's select. Toolbar wraps to icon-only; minimap
hidden; legend opens as a bottom-left card max-width `calc(100% - 24px)`. The map must never cause horizontal
page scroll (root `overflow-hidden`, width 100%).

### 4.7 Performance limits

≤ 200 device/hub nodes (§3.1 `MAX_NODES`); `only-render-visible-elements` when > 120 nodes; ≤ 60 animated
edges; layout is recomputed on every devices update but costs < 15 ms at 200 nodes; no deep watchers (computed
from props only); no per-frame JS (dots are SMIL); label LOD by zoom; lazily loaded chunk (§10.6).

---

## 5. Detail panel — `web/src/components/detail/*` (owner: detail)

### 5.1 `DeviceDetailPanel.vue`

```js
props: {
  device:    { type: Object, default: null },        // live Device (parent passes the store copy)
  open:      { type: Boolean, default: false },
  mode:      { type: String, default: 'side' },       // 'side' (absolute right slide-over inside the map wrapper) | 'sheet' (full-screen, teleported)
  devices:   { type: Array, default: () => [] },      // all devices (hub options, parent name)
  overrides: { type: Object, default: () => ({}) },
  events:    { type: Array, default: () => [] },      // state.events (newest first)
}
emits: ['close', 'reparent' /* (mac, parentMac|null) */]
```
Root: `<aside data-testid="device-detail-panel" :data-mac :data-mode role="complementary"
aria-labelledby="<heading id>">` (sheet mode: `role="dialog" aria-modal="true"`, teleported to body, focus trap
via `useOverlay` from `ui/overlay.js`, body scroll lock).
- **side**: `absolute inset-y-0 right-0 z-10 w-[380px] max-w-[calc(100%-48px)] border-l border-border
  bg-overlay shadow-modal flex flex-col`; enter `translate-x-full → 0` 240 ms `--ease-enter`, leave 180 ms.
  Non-modal: the canvas stays interactive; clicking another node swaps the content (no close/open animation).
- **sheet**: `fixed inset-0 z-50 bg-overlay flex flex-col`, enter `translate-y-full → 0`, safe-area padding.
- Close: X (`detail-close-btn`), `Esc` (document keydown, ignored when `e.defaultPrevented`, while inline
  rename is active, or while an `[aria-modal="true"]` dialog other than this sheet is open), clicking empty
  canvas (handled by the map → parent sets `selectedMac = null`). On open from keyboard focus moves to the
  heading (`tabindex="-1"`); on close the parent returns focus to the node (`map.focusNode(mac)`).
- Device disappears from the list (offline unsaved dropped, forgotten offline) → keep rendering the last
  snapshot with a muted banner "This device is no longer on the network." and disable actions except Close.

Layout (header sticky, body scrolls, footer sticky):
```
┌──────────────────────────────────────────── ✕ ┐
│ [48px tile]  Jon's iPhone  ✎                   │ detail-name (16/24 600)  — click/✎ → inline input
│              iPhone 15 Pro                     │ detail-type (13 muted, data-category, data-os)
│ ● Online                     [This device] ... │ detail-status + badges
├────────────────────────────────────────────────┤
│ CONNECTION                                     │ eyebrow
│ ┌ latency chart (96px) ──────────────────────┐ │ DetailLatencyChart
│ └────────────────────────────────────────────┘ │
│ Min 7.9 · Avg 8.4 · Max 9.1 ms                 │
│ Latency 8.4 ms  Jitter 3.9 ms  Loss 0%  [Good] │ 4 stat cells + QualityBadge (detail-quality)
│ Throughput  — Requires router integration      │ detail-throughput
│ CONNECTED VIA                                  │
│ [ Deco-M5 · Wi-Fi access point · Deco M5  ▾ ]  │ ConnectedViaSelect
│ DETAILS                                        │ DetailFacts (dl grid)
│ WHY THIS TYPE?                                 │ DetailEvidence
│ RECENT ACTIVITY                                │ DetailEvents
├────────────────────────────────────────────────┤
│ [★ Save device]   [↻ Re-detect]     [Forget]   │ footer actions
└────────────────────────────────────────────────┘
```
Header: tile 48×48 `rounded-xl` (`categoryTint(category).tile`, offline → `OFFLINE_TILE`), icon 24 px.
- **Name** `detail-name`: text = `deviceDisplayName(device)`, button-like (hover underline dotted), pencil
  IconButton `detail-name-edit-btn`. Editing: input `detail-name-input` (h-8, max 64, prefilled), Enter saves,
  Esc cancels (stopPropagation), blur saves if changed & valid. Save = existing store action
  `saveDevice(mac, { name, type: device.userType ?? null, notes: device.notes ?? '' })` (preserves type/notes);
  success toast `Renamed to “<name>”`; empty name → inline error "Give this device a name.". For an unsaved
  device a 12 px muted hint under the input: "Naming a device also saves it."
- **Type** `detail-type`: `deviceTypeLabel(device)` + OS icon (`OS_ICONS`) 12 px.
- **Status** `detail-status` (`data-status="online|offline"`): pill like DeviceStatus (success soft / neutral);
  text exactly `Online` or `Offline · last seen <formatRelative(lastSeen, now)>` (`useNow(1000)`); `title` =
  full timestamp.
- **Badges** (11 px, existing styles from DeviceIdentity): `This device` (`detail-badge-self`, accent),
  `Gateway` (`detail-badge-gateway`, network tint), `Private address` (`detail-badge-private`, `shield` icon,
  neutral; when `isPrivateMac(device)`; title "Private (randomized) Wi-Fi address — it may change if the device
  forgets this network."), `Saved` (`detail-badge-saved`, `star-filled` warning), `Type set by you` (when
  `typeSource === 'user'`, neutral, `edit` icon).

Connection section:
- Non-self: `DetailLatencyChart :values="device.latencyHistory" :quality`. Stat cells (label eyebrow 10 px,
  value 15/600 tabular): Latency `formatMs(latencyMs)` coloured by `QUALITY[q].text`; Jitter `formatMs`; Loss
  `formatPercent(lossPct)` (warning-fg >0, danger-fg ≥5); Quality `QualityBadge` inside `detail-quality`.
- Self: chart replaced by a throughput chart: client-side ring buffer (60 samples) of `rxMbps`/`txMbps`
  captured from `device` updates while open, drawn with `ui/Sparkline.vue` (two lines: accent rx, info tx,
  width = container, height 56); text `↓ 24.0 ↑ 3.0 Mbps` (`formatRate`) in `detail-throughput` with `data-rx`,
  `data-tx`; caption "Latency isn't measured for this computer."
- Others: `detail-throughput` = `—` + muted "Requires router integration" (exact string), `data-rx=""`.
- Offline: values greyed (`text-subtle`), chart `muted`, caption "Last values before it went offline".

Footer actions (h-9 buttons, wrap on narrow):
- `detail-save-btn`: primary; label `Save device` (unsaved) / `Edit` (saved, `edit` icon); opens the existing
  `DeviceEditModal` (owned by this panel instance: `:open :device @close`).
- "Change type" (link-button in DetailEvidence) opens the same modal with `focus-type`.
- `detail-redetect-btn`: secondary, `refresh` icon, Spinner while `isRedetecting(mac)`; calls
  `redetectDevice(device)` from `components/devices/devicesState.js`; disabled when offline with title
  "Device is offline — re-detect needs it online".
- `detail-forget-btn`: danger ghost, only when `device.saved`; opens the existing `ForgetDeviceDialog`; on
  `forgotten` keep the panel open (online device stays, now unsaved) — offline devices vanish → snapshot banner.

### 5.2 Sub-components

| file | props | emits | notes / testids |
|---|---|---|---|
| `DetailFacts.vue` | `device`, `parentLabel: String` (e.g. `"Deco-M5"` / `"Gateway (default)"`) | `copy(kind, value)` | `<dl class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-[13px]">`; rows: IP (`detail-ip`, tabular, copy IconButton), MAC (`detail-mac`, mono 12 px, copy), Vendor, Hostname, OS (`OS_LABELS`, `—`), Model, First seen (`formatDateTime` + muted relative), Last seen, Connected via (`parentLabel`), Notes (only when non-empty, pre-wrap). Missing values `—` in `text-subtle`. Copy uses `navigator.clipboard.writeText` in try/catch and swaps the icon to `check` for 1.5 s. |
| `DetailLatencyChart.vue` | `values: Array`, `quality: String = 'none'`, `height: Number = 96`, `muted: Boolean` | — | root `data-testid="detail-latency-chart"` with `data-samples`, `data-min`, `data-avg`, `data-max` (1 decimal or empty). SVG width = container (ResizeObserver, rAF-debounced). Y 0 → `max(20, max × 1.2)`; 3 horizontal gridlines (0, mid, top) 1 px `border` with 10 px subtle labels left (`"20 ms"` on top only); line 1.75 px in `QUALITY[q].stroke`, area gradient 18 % → 0; dashed avg line (`border-strong`, `3 3`); null samples break the line and draw a 1×5 px danger tick on the baseline; last-point dot r 2.5; hover/touch crosshair + tooltip `"8.1 ms · 12 s ago"` (sample age = (n−1−i) × ping interval, show `"#i of n"` if interval unknown). Below: `Min 7.9 · Avg 8.4 · Max 9.1 ms` (11 px muted). < 2 numeric samples: dashed baseline + "No samples yet". `role="img"` + `aria-label="Latency, last 30 pings: average 8.4 ms, max 9.1 ms, 0 lost"`. |
| `DetailEvidence.vue` | `device` | `change-type` | Header line: `Detected automatically · 92% confidence` + 4 px meter (accent) **or** `Set by you · auto-detect would say <label> (<pct>%)`; `<ul data-testid="detail-evidence">` one `<li>` per `typeEvidence` string (check icon success-fg, 12 px muted); empty → "Identifying this device…" (fingerprinting) or "Not enough information yet. Detection improves as the device responds to discovery."; footer `Wrong? [Change type]` (`detail-change-type-btn`). Uses `confidencePercent`, `deviceTypeLabel`. |
| `DetailEvents.vue` | `events: Array`, `mac: String`, `limit: Number = 8` | — | `<ul data-testid="detail-events">`; filter `e.mac === mac`, newest first; `<li data-testid="detail-event-item" :data-type>`: 24 px tinted circle icon (`device_new` plus-circle info, `device_online` arrow-up-circle success, `device_offline` circle-off neutral, `device_saved` bookmark neutral, `device_forgotten` trash neutral, other `info`), message 13 px truncate, time right `formatTime` (title `formatDateTime` + relative). Empty: "No activity for this device yet." |
| `ConnectedViaSelect.vue` | `device`, `devices`, `overrides`, `disabled: Boolean` | `change(parentMac \| null)` | Native `<select data-testid="detail-connected-via">` (styled like DeviceEditModal's select). Options from `hubOptions(device, devices, overrides)`: value `""` = Gateway (`"Gateway — unifi (default)"`), hub values = colon MAC, label `"<name> · <typeLabel>"`, offline hubs suffixed `" (offline)"`. Selected value = effective parent from `resolveParents` (`""` for null). When `parentSource === 'fallback'` show helper in warning-fg "Usually via <stored parent> — not on the network right now". Helper (12 px muted): "NetMon can't see which access point a device uses. Pick it here or drag the device onto an access point on the map." Hidden for the gateway; for hubs the label reads "Uplink". With 0 hubs: disabled select showing "Gateway" + helper "No access points or mesh nodes found on this network." Emits only on real change; after emitting it shows a 14 px Spinner next to the select (internal `pending` state) until the `overrides` prop reflects the new value or 5 s pass. |

Panel computes `parentLabel` from `resolveParents(devices, overrides).get(mac)` → hub display name or
`"Gateway (default)"` / `"Gateway"` when user-set null. It emits `reparent(mac, parentMac)` from the select.

---

## 6. Interaction flows (end to end, after integration)

1. Click node → `select(mac)` → store `selectDevice(mac)` → panel opens (side) / sheet (mobile); map
   `centerOn(mac)` if hidden under the panel.
2. Drag node to empty canvas → `move(mac, {x,y})` → `setNodePosition(mac, pos)` (optimistic) → `PUT
   /api/topology/:mac {position}` → SSE `topology` to all tabs.
3. Drag device onto a hub → `reparent(mac, hubMac)` → `setDeviceParent(mac, hubMac, { clearPosition: true })`
   → `PUT {parentMac, position: null}` → node moves into the hub's sector, edge now from the hub.
4. "Connected via" select → `reparent` → same action (`clearPosition: true`).
5. Reset layout button → `resetLayout()` → `DELETE /api/topology?scope=positions` → toast "Layout reset" →
   `map.fitView()`.
6. Search/filter/type chip in the shared toolbar → `highlight = Set(filteredDevices macs)` (null when no filter
   is active) → non-matching nodes dimmed; list view shows the same filter.
7. Esc / X / pane click → `selectDevice(null)`.

---

## 7. Server — `server/src/core/topology.js` (owner: server)

Persistence lives in its **own file** `<dataDir>/topology.json` (same debounced 500 ms atomic write pattern as
`core/store.js`: write `topology.json.tmp`, `fs.renameSync`). Rationale: `store.js`'s `sanitizeDoc` drops unknown
keys and core is being fixed in parallel; a separate file needs no store.js change. Node built-ins only.

### 7.1 Exports (exact)

```js
export const HUB_CATEGORIES = ['access_point', 'router', 'network_switch'];
export const COORD_LIMIT = 10000;
export const MAX_OVERRIDES = 1000;
export const MAC_RE = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/;
export const MOCK_DEFAULT_OVERRIDES = {
  '5a:1f:3e:8c:44:04': { parentMac: '50:c7:bf:3d:7e:06', position: null },   // Jon's iPhone  -> Deco M5
  '3c:28:6d:a1:b2:05': { parentMac: '50:c7:bf:3d:7e:06', position: null },   // Pixel 8       -> Deco M5
  'a8:23:fe:44:19:07': { parentMac: '50:c7:bf:3d:7e:06', position: null },   // LG TV         -> Deco M5
};

export function isHubDevice(d)                  // d && HUB_CATEGORIES.includes(d.category) && !d.isGateway
export function sanitizeOverrides(raw)          // drops invalid keys/values; returns { [mac]: Override }
export function wouldCreateCycle(mac, parentMac, overrides)
/**
 * Validate a PUT body for `mac`.
 * ctx = { devices: Device[] /* state.getDevices() */, overrides, known: boolean /* devices.has(mac) || store.getSaved(mac) */ }
 * → { ok: true, value: { parentMac?: string|null, position?: {x,y}|null } } | { ok: false, status: 400|404, errors: { [field]: msg } }
 */
export function validateTopologyPatch(mac, body, ctx)
/**
 * createTopologyStore({ dataDir, defaults = {} /* MOCK_DEFAULT_OVERRIDES in mock mode */, fileName = 'topology.json' })
 * → { file, load(), flush(), getOverrides(), getOverride(mac), applyPatch(mac, value) → Override|null,
 *     reset({ scope = 'positions' }) → overrides, removeOverride(mac) }
 */
export function createTopologyStore(opts)
```
`Override = { parentMac: string|null, position: { x: number, y: number } | null, updatedAt: ISO }`. An entry with
both `parentMac` and `position` null is deleted. Getters return deep copies.

Validation rules (`validateTopologyPatch`):
- `mac` already normalized by the route (`parseMac`); `!ctx.known` → `{ status: 404 }`.
- body must be a plain object containing at least one of `parentMac`, `position` (else 400 `{ _: 'Nothing to
  update' }`); unknown keys ignored.
- `parentMac`: `null` or a MAC (any form accepted by `parseMac` semantics: dashes/colons/case → lowercase colon;
  implement a local normalizer, do not import routes). Gateway MAC → normalized to `null`. Must not equal `mac`
  (`parentMac: 'A device cannot connect through itself'`). Target device is the gateway and parentMac non-null →
  `parentMac: 'The gateway cannot be re-parented'`. Parent must be in `ctx.devices` and `isHubDevice`
  (`parentMac: 'Not an access point, mesh node, switch or router on this network'`). `wouldCreateCycle` →
  `parentMac: 'That would create a loop'`.
- `position`: `null` or `{ x, y }` finite numbers with `|v| ≤ COORD_LIMIT` (`position: 'Position must be finite
  numbers within ±10000'`); rounded to 1 decimal.
`applyPatch` merges (omitted field = unchanged), sets `updatedAt`, enforces `MAX_OVERRIDES` (drop the oldest
`updatedAt`), schedules a write, returns the new Override or null (deleted). `reset({ scope: 'positions' })` sets
every `position` to null (dropping emptied entries); `reset({ scope: 'all' })` replaces everything with a deep
copy of `defaults`. `load()`: missing file → `defaults` copy (and no write until changed); corrupt file → rename
to `topology.json.corrupt-<ts>`, use `defaults`. Overrides referencing MACs that later disappear are kept (the
client falls back to the gateway; they reattach when the device returns).

### 7.2 REST additions (to be added to `routes/api.js` by the integrator; `ctx.topology` = the store above)

| Method & path | Success | Errors |
|---|---|---|
| `GET /api/topology` | `200 { "overrides": { "<mac>": Override } }` | — |
| `PUT /api/topology/:mac` | `200 { "mac", "override": Override\|null, "overrides" }`; body `{ "parentMac"?: string\|null, "position"?: {x,y}\|null }` | `400 validation` (details per field), `404 not_found` (MAC neither known nor saved) |
| `DELETE /api/topology?scope=positions\|all` | `200 { "ok": true, "overrides" }` (default scope `positions`) | `400 validation` (bad scope) |

Every successful PUT/DELETE: `state.broadcast('topology', { overrides })`. No event-log entries (layout edits
are not network events).

### 7.3 SSE + snapshot

- New SSE event `topology`, payload `{ "overrides": { … } }` (full map; small), sent after PUT/DELETE.
- Snapshot gains `"topology": { "overrides": { … } }` so (re)connects resync; mock reset broadcasts the
  snapshot, which carries the reset overrides.

### 7.4 Mock

In mock mode the store is created with `defaults: MOCK_DEFAULT_OVERRIDES` (fresh data dir → iPhone, Pixel 8, LG
TV via the Deco M5). `POST /api/mock/state {reset:true}` → `topology.reset({ scope: 'all' })` (back to the mock
defaults) before the snapshot broadcast. `newDevice` (#11 Galaxy Tab) has no override → gateway. Mock modules
are untouched.

---

## 8. Devices section integration (visual)

### 8.1 View toggle
Devices Card header `actions` slot gets `ui/Segmented.vue` (size `sm`, `label="Devices view"`):
`[{ value: 'map', label: 'Map', icon: 'network', testid: 'view-toggle-map' }, { value: 'list', label: 'List',
icon: 'list', testid: 'view-toggle-list' }]` (radios with `aria-checked`). **Map is the default.** Initial value:
URL query `?view=list|map` (read once) → `localStorage['netmon.devices.view']` → `'map'`. TypeSummary chips and
DeviceToolbar (status tabs, type select, search) stay above both views and drive both (shared `ui` state); the
sort control has no effect in map view (leave as is).

### 8.2 Map container
`<div class="relative overflow-hidden border-t border-border h-[clamp(460px,64vh,760px)] max-md:h-[62svh]
max-md:min-h-[420px]">` containing `<TopologyMap ref="map" …/>` and `<DeviceDetailPanel mode="side" …/>`
(side when the panel root width ≥ 720 px, else `mode="sheet"`). Card footer (map view) replaces the first line
with: "Lines show the path from the internet to each device; colours reflect ping quality from this computer."

### 8.3 Data-testids (complete list for this feature)
Map: `topology-map` (root; `data-node-count`, `data-group-by`), `map-node-internet` (`data-status`),
`map-node-gateway` (`data-mac`, `data-online`), `map-node-<mac-dashes>` for hubs and devices (`data-kind`,
`data-category`, `data-online`, `data-selected`, `data-dimmed`, `data-highlighted`, `data-parent`, `data-pinned`,
`data-quality`, `data-mac`), `map-hub-count`, `map-edge-internet`, `map-edge-<mac-dashes>` (`data-kind`,
`data-quality`, `data-online`, `data-animated`, `data-source`, `data-target`), `map-edge-label`,
`map-drop-hint`, `map-fit-btn`, `map-zoom-in-btn`, `map-zoom-out-btn`, `map-relayout-btn`, `map-groupby-type`,
`map-groupby-flat`, `map-legend-btn`, `map-legend`, `map-minimap`, `map-empty`, `map-truncated-note`,
`map-zoom-hint`. View: `view-toggle-map`, `view-toggle-list`.
Panel: `device-detail-panel` (`data-mac`, `data-mode`), `detail-close-btn`, `detail-name`,
`detail-name-edit-btn`, `detail-name-input`, `detail-type` (`data-category`, `data-os`), `detail-status`
(`data-status`), `detail-badge-self|gateway|private|saved`, `detail-latency-chart`, `detail-quality`,
`detail-throughput` (`data-rx`, `data-tx`), `detail-connected-via`, `detail-ip`, `detail-mac`,
`detail-evidence` (`<li>` per item), `detail-change-type-btn`, `detail-events`, `detail-event-item`
(`data-type`), `detail-save-btn`, `detail-redetect-btn`, `detail-forget-btn`.
Existing testids reused unchanged inside overlays the panel opens: `device-edit-modal`, `device-name-input`,
`device-type-select`, `save-confirm-btn`, `forget-confirm-btn`. The map never renders `device-row-*`.

### 8.4 Accessibility summary
Nodes are Tab-reachable in output order (internet is skipped, gateway first), Enter/Space opens details, Esc
closes and returns focus to the node; every node has an `aria-label`; the map root has `role="application"
aria-label="Network map"` with `aria-describedby` → sr-only text "Use the List view for a table of all devices.
Press Enter on a device to open its details."; status is never colour-only (labels, dashed offline lines,
quality words in the panel); focus rings use the global `:focus-visible` style; motion respects
`prefers-reduced-motion`; panel sheet mode traps focus.

---

## 9. Acceptance checks per owner (self-test before handing off)

- **layout**: `node --input-type=module -e "import('./web/src/components/topology/layout.js').then(m=>…)"` on a
  hand-made mock device list: 2 runs identical (`JSON.stringify` equal); no overlapping boxes (excluding pinned
  pairs); 0 and 250 devices work (`meta.truncated = 50` for 250 non-hub devices); cycle overrides fall back;
  mock reference sector order (§3.3) holds. Must not import anything that imports Vue.
- **canvas**: SFCs compile with `@vue/compiler-sfc`; works with a fake `devices` prop in light + dark; no
  console warnings about missing handles; dots disappear under emulated reduced motion.
- **detail**: SFCs compile; renders with a mock Device incl. self, gateway, offline, user-typed, no evidence.
- **server**: smoke script in the scratchpad: load/patch/reset/validate incl. cycle, gateway, coords 10001,
  unknown hub, corrupt file; defaults applied on missing file.

---

## 10. INTEGRATION CHECKLIST (later phase — the only phase that edits existing files)

### 10.1 `server/src/index.js`
- [ ] `import { createTopologyStore, MOCK_DEFAULT_OVERRIDES } from './core/topology.js'`;
      `const topology = createTopologyStore({ dataDir: DATA_DIR, defaults: MOCK ? MOCK_DEFAULT_OVERRIDES : {} }); topology.load();`
- [ ] Pass `topology` into `createApiRouter({ …, topology })`.
- [ ] Snapshot: add `topology: { overrides: topology.getOverrides() }` (preferred: `state.setTopologySource(() => topology.getOverrides())`
      in state.js and include it in `getSnapshot()`; the `/api/snapshot` route and the SSE hub both use `state.getSnapshot`).
- [ ] Mock reset branch in `applyMockState`: `topology.reset({ scope: 'all' })` **before** `sseHub.broadcast('snapshot', …)`.
- [ ] SIGINT/SIGTERM: `topology.flush()` next to `store.flush()`.

### 10.2 `server/src/core/state.js`
- [ ] `state.setTopologySource(fn)`; `getSnapshot()` → `topology: { overrides: topologySource?.() ?? {} }`.

### 10.3 `server/src/routes/api.js`
- [ ] Add the 3 routes of §7.2 **before** the 404 fallback; use the existing `parseMac`, `sendError`; call
      `validateTopologyPatch(mac, req.body, { devices: state.getDevices(), overrides: topology.getOverrides(), known: devices.has(mac) || !!store.getSaved(mac) })`;
      map `{status:404}` → `sendError(res, 404, 'not_found', 'Device not found')`, `{status:400}` → `sendError(res, 400, 'validation', 'Invalid topology data', errors)`;
      on success `state.broadcast('topology', { overrides: topology.getOverrides() })`.
- [ ] `DELETE /api/topology` validates `scope ∈ {positions, all}` (default positions).

### 10.4 `web/src/api.js`
- [ ] `api.topology = () => request('GET', '/topology')`,
      `api.updateTopology = (mac, body) => request('PUT', \`/topology/${enc(mac)}\`, body)`,
      `api.resetTopology = (scope = 'positions') => request('DELETE', \`/topology?scope=${encodeURIComponent(scope)}\`)`.
- [ ] Add `'topology'` to `STREAM_EVENTS` (otherwise the EventSource never listens for it).

### 10.5 `web/src/store.js`
- [ ] `state.topology = { overrides: {} }`; `applySnapshot`: `state.topology = { overrides: s.topology?.overrides ?? state.topology.overrides }`;
      if the snapshot has no `topology` key (older server) call `api.topology()` once and ignore 404.
- [ ] `applyStreamEvent` case `'topology'`: `state.topology.overrides = data?.overrides ?? {}`.
- [ ] `ui.devicesView` (`'map'|'list'`, initial from `?view=` → `localStorage['netmon.devices.view']` → `'map'`;
      persist on change, try/catch) and `ui.selectedMac = null` (not persisted).
- [ ] Actions (all return Promises where async; errors → `errorToast` + revert + rethrow, like `saveDevice`):
      `setDevicesView(v)`, `selectDevice(mac|null)` (normalizeMac),
      `setDeviceParent(mac, parentMac, { clearPosition = false } = {})` → optimistic merge, `PUT { parentMac, ...(clearPosition ? { position: null } : {}) }`, apply `res.overrides`; error toast title "Couldn't change the connection",
      `setNodePosition(mac, { x, y })` → optimistic, `PUT { position }`,
      `clearNodePosition(mac)` → `PUT { position: null }`,
      `resetLayout({ scope = 'positions' } = {})` → `DELETE`, success toast "Layout reset".
- [ ] Computed exports: `topologyOverrides` (`state.topology.overrides`), `pinnedCount`, `mapHighlight`
      (`null` when `ui.filter === 'all' && ui.typeFilter === 'all' && !ui.search.trim()`, else `new Set(filteredDevices.value.map(d => d.mac))`),
      `selectedDevice` (`getDevice(ui.selectedMac)`).
- [ ] On `forgetDevice` of an offline device whose mac is selected → keep `selectedMac` (panel shows the
      snapshot banner); `selectDevice(null)` happens when the user closes.

### 10.6 `web/src/components/devices/DevicesPanel.vue`
- [ ] Header actions: view toggle (§8.1) bound to `ui.devicesView` / `setDevicesView`.
- [ ] `v-if="ui.devicesView === 'map'"` → map container (§8.2) with
      `const TopologyMap = defineAsyncComponent(() => import('../topology/TopologyMap.vue'))` (keeps Vue Flow out of the main chunk)
      and props `:devices="devicesSorted" :isp="state.isp" :internet="state.internet" :speed="state.speed" :network="state.network"
      :overrides="state.topology.overrides" :selected-mac="ui.selectedMac" :highlight="mapHighlight" :loaded="state.loaded"`;
      events `@select="selectDevice" @move="setNodePosition" @reparent="(m,p) => setDeviceParent(m, p, { clearPosition: true })"
      @reset-layout="resetLayout().then(() => map.value?.fitView())"`.
- [ ] `<DeviceDetailPanel :open="!!ui.selectedMac" :device="selectedDevice ?? lastSelectedSnapshot" :mode :devices="state.devices"
      :overrides="state.topology.overrides" :events="state.events" @close="closeDetail" @reparent="(m,p) => setDeviceParent(m, p, { clearPosition: true })" />`;
      `closeDetail` = `const m = ui.selectedMac; selectDevice(null); nextTick(() => map.value?.focusNode(m))`.
      Watch `ui.selectedMac` → `map.value?.centerOn(mac)`.
- [ ] List view keeps today's markup unchanged (skeleton/empty states/table) so all list testids are unaffected.
      Optional: row click on the device name opens the detail panel in list view too (`mode="sheet"` or side overlay).
- [ ] Map view: skip the list empty-state block (the map has its own, §4.1); keep the "Clear filters" button visible in
      the toolbar area when `mapHighlight` is an empty Set.

### 10.7 Other frontend
- [ ] `App.vue`: no change required (DevicesPanel keeps no props). If the detail sheet is open, `inert` on the main
      content is handled by `useOverlay`.
- [ ] `vite.config.js`: none (Vue Flow is ESM). Verify `npm --prefix web run build` and chunk split.
- [ ] Do **not** add icons to `icons.js` for this feature (MapToolbar's fit glyph is inline SVG).

### 10.8 Tests that need updating (e2e/)
Map becomes the default view, so every spec that expects `device-row-*` on load will fail:
- [ ] `smoke.spec.js`, `devices.spec.js`, `device-types.spec.js`, `visual.spec.js`: their `openDashboard` /
      `page.goto('/')` → `page.goto('/?view=list')` (or click `view-toggle-list` after load). Reload-based
      assertions (e.g. "persists after reload") must keep `?view=list`.
- [ ] `e2e/helpers.js` (`resetMock`) is imported by visual.spec but missing in the tree right now — restore it
      (the fixing agents may already be on it); `resetMock` → `POST /api/mock/state {reset:true}` also restores the topology mock defaults.
- [ ] `alerts.spec.js`: no device-row usage — unaffected; keyboard `tabTo(..., 80)` tests target elements before the
      devices panel — unaffected, but re-run (map nodes add ~12 tab stops).
- [ ] Mobile `noHorizontalScroll` checks must pass with the map visible (390×844, 768×1024).
- [ ] New `e2e/topology.spec.js` (after integration): (1) map is default: `topology-map` visible, 1 internet, 1 gateway,
      9 other `map-node-*`, `map-edge-*` count 10 (+1 internet); (2) mock defaults: `map-node-5a-1f-3e-8c-44-04` has
      `data-parent="50:c7:bf:3d:7e:06"`; (3) click a node → `device-detail-panel` with `detail-name`, `detail-type`
      `iPhone 15 Pro`, `detail-ip` `192.168.1.61`, `detail-mac`, ≥1 `detail-evidence li`; Esc closes; (4) change
      `detail-connected-via` to `""` → `data-parent="gateway"` and persists after reload (GET /api/topology);
      (5) `devicesOffline:[TV]` → its node `data-online="false"`, edge `data-quality="offline"`; (6) search "pixel" →
      only Pixel `data-dimmed="false"`; (7) drag a node (mouse) → `PUT` and `data-pinned="true"`; `map-relayout-btn`
      clears it; (8) self node: `detail-throughput` has `data-rx`; another device shows "Requires router integration";
      (9) mobile 390×844: tap node → sheet `data-mode="sheet"`, no horizontal scroll; (10) API: PUT invalid parent /
      self parent / cycle / coords 10001 → 400; unknown mac → 404; DELETE scope=all → mock defaults restored;
      (11) reduced motion: no `animateMotion` elements.

### 10.9 Docs
- [ ] PLAN.md: add §3 rows for the topology routes, §5 `topology` event, §11 testids → link to this file.
- [ ] README: mention the Map view and that "Connected via" is user-set (no router integration).
