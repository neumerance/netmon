<script setup>
// Network topology map (TOPOLOGY.md §4.1): Internet -> gateway -> hubs -> devices on a Vue Flow canvas.
//
// Data flow: props -> buildGraph() (pure, layout.js) -> shallow node/edge arrays fed to Vue Flow. While a
// node is being dragged the arrays are frozen (Vue Flow would otherwise snap the node back to its layout
// position on the next devices update) and the latest graph is applied on drag stop.
// Transient UI state (hover, selection, drop target, zoom) lives in a reactive `ctx` provided to the
// node / edge components, so it never triggers a relayout.
//
// This component never calls the store: it emits `select`, `move`, `reparent`, `resetLayout`.
import '@vue-flow/core/dist/style.css';
import '@vue-flow/core/dist/theme-default.css';
import '@vue-flow/minimap/dist/style.css';

import { computed, markRaw, nextTick, onBeforeUnmount, provide, reactive, ref, shallowRef, watch } from 'vue';
import { VueFlow, Panel, useVueFlow, isMacOs } from '@vue-flow/core';
import { Background } from '@vue-flow/background';
import { MiniMap } from '@vue-flow/minimap';

import Icon from '../ui/Icon.vue';
import EmptyState from '../ui/EmptyState.vue';
import { uid } from '../ui/overlay.js';
import MapToolbar from './MapToolbar.vue';
import MapLegend from './MapLegend.vue';
import InternetNode from './nodes/InternetNode.vue';
import GatewayNode from './nodes/GatewayNode.vue';
import HubNode from './nodes/HubNode.vue';
import DeviceNode from './nodes/DeviceNode.vue';
import LinkEdge from './edges/LinkEdge.vue';
import { buildGraph, internetNodeData, NODE_TYPES, EDGE_TYPE, INTERNET_ID, pickDropTarget } from './layout.js';

const props = defineProps({
  devices: { type: Array, default: () => [] }, // pass devicesSorted (PLAN §5 order)
  isp: { type: Object, default: null },
  internet: { type: Object, default: null },
  speed: { type: Object, default: null },
  network: { type: Object, default: null }, // placeholder gateway IP, cidr, scanning / firstScanDone
  overrides: { type: Object, default: () => ({}) },
  selectedMac: { type: String, default: null },
  highlight: { type: Object, default: null }, // Set<mac> | null (null = no filter active)
  loaded: { type: Boolean, default: true }, // false -> skeleton
  readonly: { type: Boolean, default: false }, // true -> no dragging
});

const emit = defineEmits(['select', 'move', 'reparent', 'resetLayout']);

const FLOW_ID = 'netmon-topology';
const MIN_ZOOM = 0.2;
const MAX_ZOOM = 2;
const PANEL_WIDTH = 380; // DeviceDetailPanel side mode width
const SIDE_PANEL_MIN_ROOT = 720; // below this the parent uses the full-screen sheet
// Extra room at the top for the floating toolbar (Panel top-left) so fitted nodes never sit under it.
const FIT_OPTS = { padding: { top: '72px', bottom: '32px', left: '40px', right: '40px' }, maxZoom: 1.1 };

const nodeTypes = {
  [NODE_TYPES.internet]: markRaw(InternetNode),
  [NODE_TYPES.gateway]: markRaw(GatewayNode),
  [NODE_TYPES.hub]: markRaw(HubNode),
  [NODE_TYPES.device]: markRaw(DeviceNode),
};
const edgeTypes = { [EDGE_TYPE]: markRaw(LinkEdge) };

const rootEl = ref(null);
const descId = uid('map-desc');

/* ------------------------------------------------------------------------------------------
 * Media queries (reduced motion, minimap breakpoint, coarse small screens)
 * ---------------------------------------------------------------------------------------- */
const mqCleanups = [];
function useMedia(query, fallback = false) {
  const r = ref(fallback);
  if (typeof window === 'undefined' || !window.matchMedia) return r;
  try {
    const mql = window.matchMedia(query);
    r.value = mql.matches;
    const on = (e) => (r.value = e.matches);
    mql.addEventListener?.('change', on);
    mqCleanups.push(() => mql.removeEventListener?.('change', on));
  } catch {
    /* ignore */
  }
  return r;
}
const reducedMotion = useMedia('(prefers-reduced-motion: reduce)');
const isMd = useMedia('(min-width: 768px)', true);
const coarseSmall = useMedia('(pointer: coarse) and (max-width: 767px)');

/* ------------------------------------------------------------------------------------------
 * Prefs (localStorage 'netmon.map.prefs')
 * ---------------------------------------------------------------------------------------- */
const PREFS_KEY = 'netmon.map.prefs';
function loadPrefs() {
  const def = { groupBy: 'type', legendOpen: false, minimapOpen: true };
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return def;
    const p = JSON.parse(raw) || {};
    return {
      groupBy: p.groupBy === 'flat' ? 'flat' : 'type',
      legendOpen: p.legendOpen === true,
      minimapOpen: p.minimapOpen !== false,
    };
  } catch {
    return def;
  }
}
const prefs = reactive(loadPrefs());
watch(
  () => ({ ...prefs }),
  (p) => {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(p));
    } catch {
      /* private mode / quota: prefs are a convenience only */
    }
  },
);

/* ------------------------------------------------------------------------------------------
 * Graph
 * ---------------------------------------------------------------------------------------- */
const EMPTY_GRAPH = { nodes: [], edges: [], meta: { gatewayId: null, hubIds: [], counts: { devices: 0, hubs: 0, online: 0, offline: 0, pinned: 0 }, truncated: 0 } };

// Structural graph: everything except the ISP / speed-test fields, which only the internet node shows. Speed
// progress arrives up to ~10x a second during a test; it must not relayout and re-render every node.
const baseGraph = computed(() => {
  try {
    return buildGraph(props.devices || [], {
      internet: props.internet,
      network: props.network,
      overrides: props.overrides || {},
      highlight: props.highlight instanceof Set ? props.highlight : null,
      groupBy: prefs.groupBy,
      reducedMotion: reducedMotion.value,
    });
  } catch (err) {
    console.error('[TopologyMap] buildGraph failed', err);
    return EMPTY_GRAPH;
  }
});

const graph = computed(() => {
  const g = baseGraph.value;
  if (!g.nodes.length) return g;
  const patch = internetNodeData(props.internet, props.isp, props.speed);
  return { ...g, nodes: g.nodes.map((n) => (n.id === INTERNET_ID ? { ...n, data: { ...n.data, ...patch } } : n)) };
});

const nodeById = computed(() => new Map(graph.value.nodes.map((n) => [n.id, n])));
const gatewayId = computed(() => graph.value.meta?.gatewayId ?? null);

const flowNodes = shallowRef([]);
const flowEdges = shallowRef([]);
let pendingGraph = false;

// Last element handed to Vue Flow per id: { src, obj, sig }. An element whose content did not change keeps its
// previous object (and `data` reference), so Vue Flow and the node / edge components do not re-render it.
let prevNodes = new Map();
let prevEdges = new Map();
function reuseElements(list, prev) {
  const next = new Map();
  const out = new Array(list.length);
  list.forEach((item, i) => {
    const p = prev.get(item.id);
    let entry;
    if (p && p.src === item) {
      entry = p;
    } else {
      const sig = JSON.stringify(item);
      const samePos = !item.position || (p && p.obj.position?.x === item.position.x && p.obj.position?.y === item.position.y);
      entry = p && p.sig === sig && samePos ? { src: item, obj: p.obj, sig } : { src: item, obj: item, sig };
    }
    next.set(item.id, entry);
    out[i] = entry.obj;
  });
  return { out, next };
}

function applyGraph() {
  pendingGraph = false;
  // No network: the empty-state card replaces the graph instead of being drawn over a placeholder map.
  if (!props.loaded || !props.network) {
    flowNodes.value = [];
    flowEdges.value = [];
    prevNodes = new Map();
    prevEdges = new Map();
    return;
  }
  const g = graph.value;
  const n = reuseElements(g.nodes, prevNodes);
  const e = reuseElements(g.edges, prevEdges);
  prevNodes = n.next;
  prevEdges = e.next;
  flowNodes.value = n.out;
  flowEdges.value = e.out;
}

/* ------------------------------------------------------------------------------------------
 * Transient context for node / edge components
 * ---------------------------------------------------------------------------------------- */
const ctx = reactive({
  selectedId: null,
  hoveredId: null,
  dropTargetId: null,
  draggingId: null,
  zoom: 1,
  reducedMotion: false,
  select: (id) => selectById(id),
  nodeName: (parentMac) => nodeName(parentMac),
});
provide('nm-topology-ctx', ctx);

watch(reducedMotion, (v) => (ctx.reducedMotion = !!v), { immediate: true });
watch(
  () => props.selectedMac,
  (m) => (ctx.selectedId = m ? String(m).toLowerCase() : null),
  { immediate: true },
);

watch(
  [graph, () => props.loaded, () => !props.network],
  () => {
    if (ctx.draggingId) {
      pendingGraph = true; // apply on drag stop
      return;
    }
    applyGraph();
  },
  { immediate: true },
);

/** Display name for a parent mac (null = gateway); used in aria-labels. */
function nodeName(parentMac) {
  const id = parentMac == null ? gatewayId.value : String(parentMac);
  return nodeById.value.get(id)?.data?.name ?? (parentMac == null ? 'Gateway' : '');
}

function selectById(id) {
  const node = nodeById.value.get(id);
  if (!node) return;
  if (node.type === NODE_TYPES.internet) return;
  if (node.type === NODE_TYPES.gateway && (node.data?.placeholder || !node.data?.mac)) return;
  emit('select', node.data?.mac ?? id);
}

/* ------------------------------------------------------------------------------------------
 * Vue Flow instance
 * ---------------------------------------------------------------------------------------- */
const { fitView: vfFitView, setCenter, setViewport, zoomIn, zoomOut, viewport, findNode, getNodes } = useVueFlow(FLOW_ID);

watch(
  () => viewport.value?.zoom,
  (z) => {
    if (Number.isFinite(z)) ctx.zoom = z;
  },
  { immediate: true },
);

const nodesDraggable = computed(() => !props.readonly && !coarseSmall.value);

let didInitialFit = false;
let userMovedViewport = false;
let lastFitCount = -1;

function motion(ms) {
  return reducedMotion.value ? 0 : ms;
}

// Phone-width maps get slimmer side padding so the whole graph fits a little larger.
const NARROW_MAX_WIDTH = 640;
const NARROW_FIT_OPTS = { padding: { top: '64px', bottom: '16px', left: '12px', right: '12px' }, maxZoom: 1.1 };

// Automatic fits never go below a zoom where node names are still legible; a bigger network then opens
// centred on the gateway (pan to see the rest). The Fit button / F key always shows the whole network.
const MIN_READABLE_ZOOM = 0.6;
const MIN_READABLE_ZOOM_NARROW = 0.55;
// Flow point the readable view centres on: gateway tile with the internet card above it.
const READABLE_CENTER = { x: 0, y: -60 };

let panelFitted = false; // the viewport was moved to make room for the side detail panel
let viewBeforePanel = null; // exact viewport when the detail panel opened; restored when it closes
let restoringView = null; // Promise while that restore animation runs

async function doFit(duration = 0, { readable = false } = {}) {
  if (!flowNodes.value.length) return false;
  lastFitCount = flowNodes.value.length;
  panelFitted = false;
  const width = rootEl.value?.getBoundingClientRect().width ?? Infinity;
  const narrow = width < NARROW_MAX_WIDTH;
  const res = await vfFitView({ ...(narrow ? NARROW_FIT_OPTS : FIT_OPTS), duration });
  if (readable) {
    const min = narrow ? MIN_READABLE_ZOOM_NARROW : MIN_READABLE_ZOOM;
    const z = viewport.value?.zoom ?? 1;
    if (z < min) await setCenter(READABLE_CENTER.x, READABLE_CENTER.y, { zoom: min, duration });
  }
  return res;
}

function onNodesInitialized() {
  const count = flowNodes.value.length;
  if (!count) return;
  if (!didInitialFit) {
    didInitialFit = true;
    doFit(0, { readable: true });
    return;
  }
  // Device count changed (first scan finished, a device joined / left) and the user has not touched the
  // viewport yet -> keep everything in view. Once the user pans / zooms we leave their viewport alone, and
  // never refit while the detail panel is open (that would yank the map back under the panel).
  if (!userMovedViewport && !props.selectedMac && count !== lastFitCount) doFit(motion(250), { readable: true });
}

// The user moved the map themselves: from now on their view wins, including over the post-panel restore.
function userTookViewport() {
  userMovedViewport = true;
  viewBeforePanel = null;
}

function onMoveStart(e) {
  // d3-zoom: sourceEvent is set only for user gestures (wheel / drag / pinch), not for fitView/setCenter.
  if (e?.event?.sourceEvent) userTookViewport();
}

function onFit() {
  userMovedViewport = false;
  viewBeforePanel = null;
  doFit(motion(250));
}
function onZoomIn() {
  userTookViewport();
  zoomIn({ duration: motion(160) });
}
function onZoomOut() {
  userTookViewport();
  zoomOut({ duration: motion(160) });
}

// Group-by change re-sectors everything: refit so the new arrangement is fully visible.
watch(
  () => prefs.groupBy,
  () => nextTick(() => setTimeout(() => doFit(motion(250)), 0)),
);

/* ------------------------------------------------------------------------------------------
 * Pointer interaction
 * ---------------------------------------------------------------------------------------- */
function onNodeClick({ node }) {
  selectById(node.id);
}
function onPaneClick() {
  emit('select', null);
}
function onNodeEnter({ node }) {
  if (!ctx.draggingId) ctx.hoveredId = node.id;
}
function onNodeLeave({ node }) {
  if (ctx.hoveredId === node.id) ctx.hoveredId = null;
}

// Drag state (module-local, not reactive).
let dragExclude = [];
let dragParentId = null;
let overOwnParent = false;

function descendantsOf(id) {
  const kids = new Map();
  for (const e of graph.value.edges) {
    if (!kids.has(e.source)) kids.set(e.source, []);
    kids.get(e.source).push(e.target);
  }
  const out = [];
  const seen = new Set([id]);
  const stack = [...(kids.get(id) || [])];
  while (stack.length) {
    const c = stack.pop();
    if (seen.has(c)) continue;
    seen.add(c);
    out.push(c);
    stack.push(...(kids.get(c) || []));
  }
  return out;
}

function dropCandidates() {
  return getNodes.value
    .filter((n) => n.type === NODE_TYPES.hub || n.type === NODE_TYPES.gateway)
    .map((n) => ({ id: n.id, type: n.type, position: n.position }));
}

function onNodeDragStart({ node }) {
  ctx.draggingId = node.id;
  ctx.hoveredId = null;
  ctx.dropTargetId = null;
  overOwnParent = false;
  dragExclude = [node.id, ...descendantsOf(node.id)];
  dragParentId = node.data?.parentMac ?? gatewayId.value;
}

function onNodeDrag({ node }) {
  if (!ctx.draggingId) return;
  const target = pickDropTarget({ id: node.id, type: node.type, position: node.position }, dropCandidates(), {
    excludeIds: dragExclude,
  });
  // Hovering the node's current parent is not a re-parent: no hint, and dropping there cancels the drag.
  overOwnParent = !!target && target === dragParentId;
  const next = overOwnParent ? null : target;
  if (ctx.dropTargetId !== next) ctx.dropTargetId = next;
}

function onNodeDragStop({ node }) {
  const target = ctx.dropTargetId;
  const cancelled = overOwnParent;
  const mac = node.data?.mac ?? node.id;
  ctx.dropTargetId = null;
  overOwnParent = false;

  let resync = pendingGraph || cancelled;
  if (target && target !== dragParentId) {
    // Snap into the new parent's sector; the store clears the pinned position (clearPosition: true).
    emit('reparent', mac, target === gatewayId.value ? null : target);
    resync = true;
  } else if (!cancelled) {
    emit('move', mac, { x: Math.round(node.position.x), y: Math.round(node.position.y) });
  }
  ctx.draggingId = null;
  dragExclude = [];
  dragParentId = null;
  // The parent's optimistic update (if any) has already invalidated `graph`; re-sync on the next tick so the
  // node lands where the layout now says (or snaps back when nothing changed / the drop was cancelled).
  if (resync) nextTick(applyGraph);
}

/* ------------------------------------------------------------------------------------------
 * Keyboard + wheel
 * ---------------------------------------------------------------------------------------- */
function isTypingTarget(t) {
  return !!t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
}

function onKeydown(e) {
  if (e.defaultPrevented) return;
  if (e.key === 'Escape') {
    if (ctx.draggingId) return;
    emit('select', null);
    return;
  }
  if (e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(e.target)) return;
  if (e.key === 'f' || e.key === 'F') {
    e.preventDefault();
    onFit();
  } else if (e.key === '+' || e.key === '=') {
    e.preventDefault();
    onZoomIn();
  } else if (e.key === '-' || e.key === '_') {
    e.preventDefault();
    onZoomOut();
  }
}

const zoomHint = ref(false);
const zoomHintText = isMacOs() ? 'Use ⌘ + scroll to zoom' : 'Use Ctrl + scroll to zoom';
let zoomHintTimer = null;
function onWheel(e) {
  // Ctrl/⌘ + wheel and trackpad pinch (ctrlKey) zoom the map; a plain wheel keeps scrolling the page.
  if (e.ctrlKey || e.metaKey) {
    zoomHint.value = false;
    return;
  }
  if (Math.abs(e.deltaY) < 1 && Math.abs(e.deltaX) < 1) return;
  zoomHint.value = true;
  clearTimeout(zoomHintTimer);
  zoomHintTimer = setTimeout(() => (zoomHint.value = false), 1500);
}

// Focus moved to a node with Tab: the browser may scroll the overflow-hidden flow container to reveal it,
// which desynchronises Vue Flow's coordinates. Undo that scroll and pan the viewport instead.
function onFocusIn(e) {
  const el = e.target;
  if (!(el instanceof HTMLElement) || !el.hasAttribute('data-node-focus')) return;
  resetScroll();
  const nodeEl = el.closest('.vue-flow__node');
  const id = nodeEl?.getAttribute('data-id');
  if (id) {
    const n = nodeById.value.get(id);
    if (n?.data?.mac) {
      const mac = n.data.mac;
      const pw = props.selectedMac ? undefined : 0;
      // The panel just closed and the pre-panel view is being restored: centre (only if still needed) once
      // that has settled, instead of panning from the stale panel-side viewport and undoing it.
      if (restoringView) restoringView.then(() => centerOn(mac, { panelWidth: pw }));
      else centerOn(mac, { panelWidth: pw });
    }
  }
  requestAnimationFrame(resetScroll);
}
function resetScroll() {
  const root = rootEl.value;
  if (!root) return;
  for (const el of [root, ...root.querySelectorAll('.vue-flow, .vue-flow__container, .vue-flow__viewport, .vue-flow__renderer')]) {
    if (el.scrollTop) el.scrollTop = 0;
    if (el.scrollLeft) el.scrollLeft = 0;
  }
}

/* ------------------------------------------------------------------------------------------
 * Exposed API
 * ---------------------------------------------------------------------------------------- */
function idForMac(mac) {
  if (!mac) return null;
  const m = String(mac).toLowerCase();
  if (nodeById.value.has(m)) return m;
  // Allow dashed form too.
  const colon = m.replace(/-/g, ':');
  return nodeById.value.has(colon) ? colon : null;
}

/** Fit the whole graph into view (also re-enables auto-fit on device-count changes). */
function fitView(opts = {}) {
  userMovedViewport = false;
  viewBeforePanel = null;
  return doFit(opts.duration ?? motion(250));
}

/** Move keyboard focus to a node's focusable tile (used when the detail panel closes). */
function focusNode(mac) {
  const id = idForMac(mac);
  const n = id && nodeById.value.get(id);
  if (!n?.data?.testid || !rootEl.value) return false;
  const query = () => rootEl.value?.querySelector(`[data-testid="${n.data.testid}"] [data-node-focus]`);
  const el = query();
  if (!el) {
    // Large maps only render visible nodes: bring it into view, then focus it once Vue Flow has rendered it.
    // Never leave focus on <body>: fall back to the map itself.
    const bring = () => centerOn(mac, { force: true, panelWidth: 0 });
    if (restoringView) restoringView.then(bring);
    else bring();
    setTimeout(() => {
      const later = query();
      if (later) later.focus({ preventScroll: true });
      else rootEl.value?.focus({ preventScroll: true });
      resetScroll();
    }, motion(300) + 60);
    return false;
  }
  el.focus({ preventScroll: true });
  resetScroll();
  return true;
}

/**
 * Centre the viewport on a node's anchor, keeping the current zoom. By default only moves when the node is
 * out of view or hidden under the side detail panel (380 px, when the map is ≥ 720 px wide).
 * @param {string} mac
 * @param {{ force?: boolean, panelWidth?: number }} [opts]
 */
function centerOn(mac, { force = false, panelWidth } = {}) {
  const id = idForMac(mac);
  if (!id || !rootEl.value) return false;
  const node = findNode(id);
  if (!node) return false;
  const anchor = node.data?.anchor || { x: (node.dimensions?.width || 0) / 2, y: (node.dimensions?.height || 0) / 2 };
  const pos = node.computedPosition || node.position;
  const fx = pos.x + anchor.x;
  const fy = pos.y + anchor.y;
  const vp = viewport.value || { x: 0, y: 0, zoom: 1 };
  const z = vp.zoom || 1;
  const rect = rootEl.value.getBoundingClientRect();
  const pw = panelWidth ?? (rect.width >= SIDE_PANEL_MIN_ROOT ? PANEL_WIDTH : 0);
  const sx = fx * z + vp.x;
  const sy = fy * z + vp.y;
  const margin = 56;
  const visible = sx >= margin && sx <= rect.width - pw - margin && sy >= margin && sy <= rect.height - margin;
  if (visible && !force) {
    if (pw > 0) makeRoomForPanel(pw, rect, sx);
    return false;
  }
  // Moved to clear the side panel (not a user gesture); the pre-panel view is restored when it closes.
  if (pw > 0) panelFitted = panelFitted || !userMovedViewport;
  setCenter(fx + pw / 2 / z, fy, { zoom: z, duration: motion(300) });
  return true;
}

/**
 * The side panel covers the right part of the canvas, so nodes under it could not be clicked to swap the
 * panel's content. Move the graph out from under it: refit into the uncovered area when the user has not
 * moved the viewport and names stay legible there, else pan left as far as the graph's left edge allows.
 */
function makeRoomForPanel(pw, rect, nodeSx) {
  const b = meta.value.bounds;
  if (!b || !Number.isFinite(b.minX)) return;
  const vp = viewport.value || { x: 0, y: 0, zoom: 1 };
  const z = vp.zoom || 1;
  const gap = 16;
  const left = b.minX * z + vp.x;
  const right = b.maxX * z + vp.x;
  const limit = rect.width - pw - gap;
  if (right <= limit) return;
  if (!userMovedViewport) {
    const pad = FIT_OPTS.padding;
    const fitZ = Math.min((limit - 40) / (b.maxX - b.minX), (rect.height - 104) / (b.maxY - b.minY), z);
    if (fitZ >= MIN_READABLE_ZOOM) {
      panelFitted = true;
      vfFitView({ padding: { ...pad, right: `${pw + gap}px` }, maxZoom: z, duration: motion(300) });
      return;
    }
  }
  // Pan only: never push the left edge of the graph (or the selected node) out of view.
  const dx = Math.min(right - limit, left - gap, nodeSx - 56);
  if (dx <= 1) return;
  panelFitted = !userMovedViewport;
  setViewport({ x: vp.x - dx, y: vp.y, zoom: z }, { duration: motion(300) });
}

// Detail panel open/close. On open, remember the exact viewport (this watcher runs before DevicesPanel's
// nextTick centerOn moves the map aside). On close, animate back to that same position and zoom, unless the
// user panned / zoomed / fitted while the panel was open (their view wins then).
watch(
  () => props.selectedMac,
  (m, old) => {
    if (m && !old) {
      const vp = viewport.value;
      viewBeforePanel = vp ? { x: vp.x, y: vp.y, zoom: vp.zoom } : null;
      return;
    }
    if (m || !old) return;
    panelFitted = false;
    const saved = viewBeforePanel;
    viewBeforePanel = null;
    if (!saved) return;
    const p = Promise.resolve(setViewport(saved, { duration: motion(250) }))
      .catch(() => {})
      .finally(() => {
        if (restoringView === p) restoringView = null;
      });
    restoringView = p;
  },
);

defineExpose({ fitView, focusNode, centerOn });

/* ------------------------------------------------------------------------------------------
 * Derived view state
 * ---------------------------------------------------------------------------------------- */
const meta = computed(() => graph.value.meta || EMPTY_GRAPH.meta);

// Map size (for the minimap rule below).
const rootSize = reactive({ w: 0, h: 0 });
let ro = null;
watch(rootEl, (el) => {
  ro?.disconnect();
  ro = null;
  if (!el || typeof ResizeObserver === 'undefined') return;
  ro = new ResizeObserver(([entry]) => {
    rootSize.w = entry.contentRect.width;
    rootSize.h = entry.contentRect.height;
  });
  ro.observe(el);
});
// The minimap only helps when part of the network is off screen (or the network is big).
const minimapUseful = computed(() => {
  if (flowNodes.value.length > 15) return true;
  const b = meta.value.bounds;
  if (!b || !Number.isFinite(b.minX) || !rootSize.w) return false;
  const vp = viewport.value || { x: 0, y: 0, zoom: 1 };
  const z = vp.zoom || 1;
  return b.minX * z + vp.x < 0 || b.minY * z + vp.y < 0 || b.maxX * z + vp.x > rootSize.w || b.maxY * z + vp.y > rootSize.h;
});
const pinnedCount = computed(() => meta.value.counts?.pinned ?? 0);
const truncated = computed(() => Number(meta.value.truncated) || 0);
const totalDevices = computed(() => (props.devices || []).length);
// Device + hub nodes actually drawn, and how many that would have been without the MAX_NODES cap.
const renderedDevices = computed(() => (meta.value.counts?.devices ?? 0) + (meta.value.counts?.hubs ?? 0));

const overlay = computed(() => {
  if (!props.loaded) return 'loading';
  if (!props.network) return 'no-network';
  if (totalDevices.value === 0 && (props.network.scanning || !props.network.firstScanDone)) return 'scanning';
  if (props.highlight instanceof Set && props.highlight.size === 0 && totalDevices.value > 0) return 'no-match';
  return null;
});
const scanLabel = computed(() => (props.network?.cidr ? `Scanning ${props.network.cidr}…` : 'Scanning your network…'));

function minimapClass(n) {
  const d = n.data || {};
  const key = n.type === NODE_TYPES.hub ? 'network' : d.group || n.type;
  return ['nm-mm', `nm-mm-${key}`, d.dimmed ? 'nm-mm-dim' : '', d.online === false ? 'nm-mm-off' : ''].filter(Boolean).join(' ');
}

onBeforeUnmount(() => {
  clearTimeout(zoomHintTimer);
  ro?.disconnect();
  for (const fn of mqCleanups) fn();
});
</script>

<template>
  <div
    ref="rootEl"
    class="nm-topology relative h-full w-full overflow-hidden bg-bg"
    data-testid="topology-map"
    :data-node-count="flowNodes.length"
    :data-group-by="prefs.groupBy"
    :data-overlay="overlay || undefined"
    role="application"
    tabindex="-1"
    aria-label="Network map"
    :aria-describedby="descId"
    @keydown="onKeydown"
    @wheel.passive="onWheel"
    @focusin="onFocusIn"
  >
    <p :id="descId" class="sr-only">
      Use the List view for a table of all devices. Press Enter on a device to open its details.
    </p>

    <VueFlow
      :id="FLOW_ID"
      class="nm-flow"
      :nodes="flowNodes"
      :edges="flowEdges"
      :node-types="nodeTypes"
      :edge-types="edgeTypes"
      :min-zoom="MIN_ZOOM"
      :max-zoom="MAX_ZOOM"
      :nodes-connectable="false"
      :elements-selectable="false"
      :nodes-focusable="false"
      :edges-focusable="false"
      :edges-updatable="false"
      :delete-key-code="null"
      :selection-key-code="null"
      :multi-selection-key-code="null"
      :zoom-on-scroll="false"
      :zoom-on-pinch="true"
      :pan-on-scroll="false"
      :prevent-scrolling="false"
      :zoom-on-double-click="false"
      :node-drag-threshold="4"
      :nodes-draggable="nodesDraggable"
      :only-render-visible-elements="flowNodes.length > 120"
      :auto-pan-on-node-drag="true"
      :disable-keyboard-a11y="true"
      @nodes-initialized="onNodesInitialized"
      @node-click="onNodeClick"
      @pane-click="onPaneClick"
      @node-mouse-enter="onNodeEnter"
      @node-mouse-leave="onNodeLeave"
      @node-drag-start="onNodeDragStart"
      @node-drag="onNodeDrag"
      @node-drag-stop="onNodeDragStop"
      @move-start="onMoveStart"
    >
      <Background variant="dots" :gap="24" :size="1" />

      <Panel position="top-left" class="nm-panel">
        <MapToolbar
          :zoom="ctx.zoom"
          :group-by="prefs.groupBy"
          :legend-open="prefs.legendOpen"
          :pinned-count="pinnedCount"
          :node-count="flowNodes.length"
          :min-zoom="MIN_ZOOM"
          :max-zoom="MAX_ZOOM"
          @fit="onFit"
          @zoom-in="onZoomIn"
          @zoom-out="onZoomOut"
          @relayout="emit('resetLayout')"
          @update:group-by="(v) => (prefs.groupBy = v === 'flat' ? 'flat' : 'type')"
          @toggle-legend="prefs.legendOpen = !prefs.legendOpen"
        />
      </Panel>

      <Panel v-if="prefs.legendOpen" position="bottom-left" class="nm-panel">
        <MapLegend @close="prefs.legendOpen = false" />
      </Panel>

      <Panel v-if="truncated > 0" position="top-right" class="nm-panel">
        <p
          class="max-w-[260px] rounded-md border border-border bg-surface/90 px-2 py-1 text-[11px] leading-4 text-muted shadow-popover backdrop-blur"
          data-testid="map-truncated-note"
        >
          Showing {{ renderedDevices }} of {{ renderedDevices + truncated }} devices — use List for all
        </p>
      </Panel>

      <MiniMap
        v-if="isMd && prefs.minimapOpen && flowNodes.length > 0 && minimapUseful"
        position="bottom-right"
        class="nm-panel"
        pannable
        zoomable
        :width="168"
        :height="112"
        :node-class-name="minimapClass"
        :node-border-radius="6"
        aria-label="Map overview"
        data-testid="map-minimap"
      />
    </VueFlow>

    <!-- Loading / empty overlays (pointer-events only on their own controls) -->
    <div
      v-if="overlay === 'loading'"
      class="pointer-events-none absolute inset-0 z-[5] flex items-center justify-center"
      data-testid="map-empty"
      data-reason="loading"
      aria-busy="true"
    >
      <div class="relative h-[180px] w-[240px]" aria-hidden="true">
        <span class="nm-skeleton absolute left-1/2 top-0 h-14 w-14 -translate-x-1/2" style="border-radius: 9999px" />
        <span class="nm-skeleton absolute bottom-0 left-4 h-12 w-12" style="border-radius: 9999px" />
        <span class="nm-skeleton absolute bottom-0 right-4 h-12 w-12" style="border-radius: 9999px" />
      </div>
      <span class="sr-only">Loading network map…</span>
    </div>

    <div
      v-else-if="overlay === 'no-network'"
      class="pointer-events-none absolute inset-0 z-[5] flex items-center justify-center p-4"
      data-testid="map-empty"
      data-reason="no-network"
    >
      <div class="pointer-events-auto rounded-xl border border-border bg-surface/95 shadow-popover backdrop-blur">
        <EmptyState
          icon="wifi-off"
          title="No network connection"
          message="NetMon can't see a local network on this computer. Connect to Wi-Fi or Ethernet to map your devices."
          compact
        />
      </div>
    </div>

    <div
      v-else-if="overlay === 'scanning'"
      class="pointer-events-none absolute inset-x-0 bottom-[18%] z-[5] flex justify-center px-4"
      data-testid="map-empty"
      data-reason="scanning"
      role="status"
    >
      <span class="inline-flex h-8 items-center gap-2 rounded-full border border-border bg-surface/95 px-3 text-xs font-medium text-muted shadow-popover backdrop-blur">
        <Icon name="radar" :size="16" class="nm-spin text-accent-fg" />
        {{ scanLabel }}
      </span>
    </div>

    <div
      v-else-if="overlay === 'no-match'"
      class="pointer-events-none absolute inset-x-0 top-14 z-[5] flex justify-center px-4"
      data-testid="map-empty"
      data-reason="no-match"
      role="status"
    >
      <span class="inline-flex h-7 items-center gap-1.5 rounded-full border border-border bg-surface/95 px-3 text-xs font-medium text-muted shadow-popover backdrop-blur">
        <Icon name="filter" :size="14" />
        No devices match these filters
      </span>
    </div>

    <!-- Plain wheel over the canvas scrolls the page; tell people how to zoom. -->
    <Transition
      enter-active-class="transition-opacity duration-150"
      leave-active-class="transition-opacity duration-300"
      enter-from-class="opacity-0"
      leave-to-class="opacity-0"
    >
      <div
        v-if="zoomHint"
        class="pointer-events-none absolute inset-x-0 bottom-4 z-[6] flex justify-center px-4"
        data-testid="map-zoom-hint"
        aria-hidden="true"
      >
        <span class="inline-flex h-7 items-center rounded-full bg-text/85 px-3 text-xs font-medium text-bg shadow-popover">
          {{ zoomHintText }}
        </span>
      </div>
    </Transition>
  </div>
</template>

<style>
/* Global (non-scoped) Vue Flow theming — every selector is prefixed with .nm-topology (TOPOLOGY.md §4.1). */
.nm-topology .vue-flow {
  background: transparent;
}
.nm-topology .vue-flow__node {
  padding: 0;
  border: 0;
  background: transparent;
  box-shadow: none;
  border-radius: 0;
  color: inherit;
  font-size: inherit;
  width: auto;
  text-align: left;
}
.nm-topology .vue-flow__node:focus,
.nm-topology .vue-flow__node:focus-visible {
  outline: none;
}
.nm-topology .vue-flow__node.draggable {
  cursor: grab;
}
.nm-topology .vue-flow__node.dragging {
  cursor: grabbing;
  /* Hubs (1) and the gateway (2) carry inline z-indexes; the dragged node must stay above its drop target. */
  z-index: 1000 !important;
}
.nm-topology:focus {
  outline: none;
}
.nm-topology .vue-flow__background pattern circle {
  fill: var(--color-border-strong);
}
.nm-topology .vue-flow__pane {
  cursor: grab;
}
.nm-topology .vue-flow__pane.dragging {
  cursor: grabbing;
}
.nm-topology .vue-flow__panel {
  margin: 12px;
}
.nm-topology .vue-flow__minimap {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-popover);
  overflow: hidden;
}
.nm-topology .vue-flow__minimap svg {
  display: block;
}
.nm-topology .vue-flow__minimap-mask {
  fill: color-mix(in oklab, var(--color-bg) 72%, transparent);
  stroke: var(--color-border-strong);
  stroke-width: 1;
}
.nm-topology .vue-flow__minimap-node {
  stroke: none;
}
.nm-topology .nm-mm-computer {
  fill: var(--color-cat-computer);
}
.nm-topology .nm-mm-mobile {
  fill: var(--color-cat-mobile);
}
.nm-topology .nm-mm-media {
  fill: var(--color-cat-media);
}
.nm-topology .nm-mm-iot {
  fill: var(--color-cat-iot);
}
.nm-topology .nm-mm-network,
.nm-topology .nm-mm-hub,
.nm-topology .nm-mm-internet,
.nm-topology .nm-mm-gateway {
  fill: var(--color-cat-network);
}
.nm-topology .nm-mm-unknown,
.nm-topology .nm-mm-device {
  fill: var(--color-cat-unknown);
}
.nm-topology .nm-mm-off {
  fill: var(--color-subtle);
  fill-opacity: 0.6;
}
.nm-topology .nm-mm-dim {
  fill-opacity: 0.25;
}
.nm-topology .vue-flow__handle {
  opacity: 0;
  pointer-events: none;
  width: 1px;
  height: 1px;
  min-width: 0;
  min-height: 0;
  border: 0;
  background: transparent;
}
.nm-topology .vue-flow__edge {
  cursor: default;
}
.nm-topology .vue-flow__edge-labels {
  pointer-events: none;
}
/* Text halo keeps node labels legible where they cross edges or the dot grid. */
.nm-topology .nm-halo {
  text-shadow:
    0 0 1px var(--color-bg),
    0 0 2px var(--color-bg),
    0 0 3px var(--color-bg),
    0 0 4px var(--color-bg);
}
.nm-topology .nm-edge-label {
  text-shadow: none;
}
</style>
